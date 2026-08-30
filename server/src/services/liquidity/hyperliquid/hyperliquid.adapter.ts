/**
 * Hyperliquid Liquidity & Hedging Adapter
 * Phase 10.5 — Step 10.5-2
 */

import {
  HedgeOrderRequest,
  HedgeOrderResult,
  HedgeOrderStatus,
  HyperliquidClientConfig,
  HyperliquidError,
  HyperliquidErrorCode,
  HyperliquidL2BookResponse,
  HyperliquidClearinghouseState,
  HyperliquidSpotClearinghouseState,
  HyperliquidMetaResponse,
  HyperliquidSpotMetaResponse,
  HyperliquidOrderWire,
  HyperliquidOrderTypeSpec,
  HyperliquidOpenOrder,
  HyperliquidUserFill,
  HyperliquidOrderStatusResponse,
  HyperliquidOrderPlacementStatus
} from './hyperliquid.types';
import { HyperliquidClient } from './hyperliquid.client';
import { decimalCompare, decimalSubtract } from '../../ledger/decimal';

export interface SymbolMarketInfo {
  coin: string;
  assetIndex: number;
  isSpot: boolean;
  szDecimals: number;
  maxLeverage: number;
}

export class HyperliquidAdapter {
  private readonly client: HyperliquidClient;
  private isHedgeHaltedState: boolean = false;
  private isReduceOnlyState: boolean = false;

  // Market metadata cache
  private perpMetaCache: Map<string, SymbolMarketInfo> = new Map();
  private spotMetaCache: Map<string, SymbolMarketInfo> = new Map();
  private lastMetaFetch: number = 0;
  private readonly metaCacheTtlMs: number = 300000; // 5 minutes

  constructor(private readonly config: HyperliquidClientConfig) {
    this.client = new HyperliquidClient(config);
  }

  public getClient(): HyperliquidClient {
    return this.client;
  }

  // ==========================================
  // 1. CIRCUIT BREAKER & SAFETY MODES
  // ==========================================

  public isHedgeHalted(): boolean {
    return this.isHedgeHaltedState;
  }

  public setHedgeHalted(halted: boolean): void {
    this.isHedgeHaltedState = halted;
  }

  public isReduceOnlyMode(): boolean {
    return this.isReduceOnlyState;
  }

  public setReduceOnlyMode(reduceOnly: boolean): void {
    this.isReduceOnlyState = reduceOnly;
  }

  // ==========================================
  // 2. METADATA & SYMBOL RESOLUTION
  // ==========================================

  public async refreshMarketMetadata(): Promise<void> {
    const perpMeta: HyperliquidMetaResponse = await this.client.getMeta();
    const spotMeta: HyperliquidSpotMetaResponse = await this.client.getSpotMeta();

    this.perpMetaCache.clear();
    perpMeta.universe.forEach((asset, idx) => {
      const info: SymbolMarketInfo = {
        coin: asset.name,
        assetIndex: idx,
        isSpot: false,
        szDecimals: asset.szDecimals,
        maxLeverage: asset.maxLeverage
      };
      const upper = asset.name.toUpperCase();
      this.perpMetaCache.set(upper, info);
      this.perpMetaCache.set(`${upper}-PERP`, info);
      this.perpMetaCache.set(`${upper}-USDT`, info);
      this.perpMetaCache.set(`${upper}-USDC`, info);
      this.perpMetaCache.set(`${upper}/USDT`, info);
      this.perpMetaCache.set(`${upper}/USDC`, info);
    });

    this.spotMetaCache.clear();
    spotMeta.universe.forEach((asset) => {
      const baseToken = spotMeta.tokens[asset.tokens[0]];
      const info: SymbolMarketInfo = {
        coin: asset.name,
        assetIndex: 10000 + asset.index,
        isSpot: true,
        szDecimals: baseToken?.szDecimals ?? 8,
        maxLeverage: 1
      };
      const upper = asset.name.toUpperCase();
      this.spotMetaCache.set(upper, info);
      this.spotMetaCache.set(upper.replace('/', '-'), info);
      this.spotMetaCache.set(`SPOT-${upper}`, info);
      this.spotMetaCache.set(`SPOT-${upper.replace('/', '-')}`, info);
    });

    this.lastMetaFetch = Date.now();
  }

  public async resolveMarketInfo(symbol: string): Promise<SymbolMarketInfo> {
    if (Date.now() - this.lastMetaFetch > this.metaCacheTtlMs || this.perpMetaCache.size === 0) {
      await this.refreshMarketMetadata();
    }

    const upper = symbol.toUpperCase();
    const hyphenated = upper.replace('/', '-');

    // Check Perp cache first
    const perp = this.perpMetaCache.get(upper) || this.perpMetaCache.get(hyphenated);
    if (perp) return perp;

    // Check Spot cache
    const spot = this.spotMetaCache.get(upper) || this.spotMetaCache.get(hyphenated);
    if (spot) return spot;

    // Fallback: strip suffix if user provided BTC-USDT and asset is BTC
    const base = hyphenated.split('-')[0];
    const basePerp = this.perpMetaCache.get(base);
    if (basePerp) return basePerp;

    throw new HyperliquidError(
      HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
      `Unrecognized market symbol for Hyperliquid: ${symbol}`
    );
  }

  // ==========================================
  // 3. HEDGE ORDER EXECUTION
  // ==========================================

  public async placeHedgeOrder(request: HedgeOrderRequest): Promise<HedgeOrderResult> {
    if (this.isHedgeHaltedState) {
      throw new HyperliquidError(
        HyperliquidErrorCode.CIRCUIT_BREAKER_TRIPPED,
        'Hyperliquid hedge execution is halted by circuit breaker (HYPERLIQUID_HEDGE_HALT)'
      );
    }

    if (this.isReduceOnlyState && !request.reduceOnly) {
      throw new HyperliquidError(
        HyperliquidErrorCode.REDUCE_ONLY_VIOLATION,
        'Venue is in REDUCE_ONLY mode; exposure-increasing hedge orders are rejected'
      );
    }

    const marketInfo = await this.resolveMarketInfo(request.symbol);
    const cloid = this.client.generateCloid(request.hedgeIntentId);

    // Format quantity strictly to szDecimals
    const formattedSz = this.formatQuantity(request.quantity, marketInfo.szDecimals);
    if (decimalCompare(formattedSz, '0') <= 0) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
        `Order quantity ${request.quantity} rounded to zero at precision ${marketInfo.szDecimals}`
      );
    }

    // Determine order type & price
    const tif = request.timeInForce === 'IOC' ? 'Ioc' : (request.timeInForce === 'ALO' ? 'Alo' : 'Gtc');
    const limitPx = request.limitPrice || '0';

    const orderWire: HyperliquidOrderWire = {
      a: marketInfo.assetIndex,
      b: request.side === 'BUY',
      p: limitPx,
      s: formattedSz,
      r: !!request.reduceOnly,
      t: { limit: { tif } },
      c: cloid
    };

    const submittedAt = new Date();

    try {
      const response = await this.client.postExchangeAction({
        type: 'order',
        orders: [orderWire],
        grouping: 'na'
      });

      const statusData = response.response?.data?.statuses?.[0];
      return this.mapOrderPlacementResult(request, cloid, statusData, submittedAt, response);
    } catch (err: any) {
      if (err instanceof HyperliquidError && err.code === HyperliquidErrorCode.NETWORK_TIMEOUT) {
        // Return UNKNOWN state for recovery flow
        return {
          hedgeIntentId: request.hedgeIntentId,
          cloid,
          status: 'UNKNOWN',
          requestedQuantity: request.quantity,
          executedQuantity: '0',
          remainingQuantity: request.quantity,
          error: 'Network timeout during submission',
          timestamps: { submittedAt }
        };
      }
      throw err;
    }
  }

  public async cancelHedgeOrder(
    venueOrderId: number | string,
    symbol: string,
    cloid?: string
  ): Promise<boolean> {
    const marketInfo = await this.resolveMarketInfo(symbol);

    try {
      if (cloid) {
        const res = await this.client.postExchangeAction({
          type: 'cancelByCloid',
          cancels: [{ asset: marketInfo.assetIndex, cloid }]
        });
        return res.status === 'ok';
      } else {
        const oid = typeof venueOrderId === 'string' ? parseInt(venueOrderId, 10) : venueOrderId;
        const res = await this.client.postExchangeAction({
          type: 'cancel',
          cancels: [{ a: marketInfo.assetIndex, o: oid }]
        });
        return res.status === 'ok';
      }
    } catch (err: any) {
      if (err.message?.includes('already canceled') || err.message?.includes('unknown order')) {
        return true; // Idempotent success
      }
      throw err;
    }
  }

  // ==========================================
  // 4. UNKNOWN ORDER RECOVERY & STATUS
  // ==========================================

  /**
   * Recovers an order in UNKNOWN state by executing a 3-step query:
   * 1. Query orderStatus by oid / cloid
   * 2. Query openOrders to check if resting
   * 3. Query userFills to verify if executed
   */
  public async recoverUnknownOrder(
    hedgeIntentId: string,
    symbol: string,
    venueOrderId?: string
  ): Promise<HedgeOrderResult> {
    const cloid = this.client.generateCloid(hedgeIntentId);
    const now = new Date();

    // 1. Check open orders
    const openOrders = await this.client.getOpenOrders();
    const matchingOpen = openOrders.find(o => (venueOrderId && o.oid.toString() === venueOrderId) || o.cloid === cloid);

    if (matchingOpen) {
      const executed = decimalSubtract(matchingOpen.origSz, matchingOpen.sz);
      const status: HedgeOrderStatus = decimalCompare(executed, '0') > 0 ? 'PARTIALLY_FILLED' : 'OPEN';
      return {
        hedgeIntentId,
        cloid,
        venueOrderId: matchingOpen.oid.toString(),
        status,
        requestedQuantity: matchingOpen.origSz,
        executedQuantity: executed,
        remainingQuantity: matchingOpen.sz,
        averagePrice: matchingOpen.limitPx,
        timestamps: { submittedAt: new Date(matchingOpen.timestamp), resolvedAt: now }
      };
    }

    // 2. Check user fills
    const fills = await this.client.getUserFills();
    const matchingFill = fills.find(f => (venueOrderId && f.oid.toString() === venueOrderId) || f.cloid === cloid);

    if (matchingFill) {
      return {
        hedgeIntentId,
        cloid,
        venueOrderId: matchingFill.oid.toString(),
        status: 'FILLED',
        requestedQuantity: matchingFill.sz,
        executedQuantity: matchingFill.sz,
        remainingQuantity: '0',
        averagePrice: matchingFill.px,
        fee: matchingFill.fee,
        feeAsset: matchingFill.feeToken,
        timestamps: { submittedAt: new Date(matchingFill.time), resolvedAt: now }
      };
    }

    // 3. Fallback to orderStatus by OID if available
    if (venueOrderId) {
      const oidNum = parseInt(venueOrderId, 10);
      const statusRes = await this.client.getOrderStatus(oidNum);
      if (statusRes.status === 'order' && statusRes.order) {
        const statStr = statusRes.order.status.toLowerCase();
        let status: HedgeOrderStatus = 'UNKNOWN';
        if (statStr === 'filled') status = 'FILLED';
        else if (statStr === 'open') status = 'OPEN';
        else if (statStr === 'canceled') status = 'CANCELED';
        else if (statStr === 'rejected') status = 'REJECTED';

        return {
          hedgeIntentId,
          cloid,
          venueOrderId,
          status,
          requestedQuantity: statusRes.order.order.origSz,
          executedQuantity: statStr === 'filled' ? statusRes.order.order.origSz : '0',
          remainingQuantity: statStr === 'filled' ? '0' : statusRes.order.order.sz,
          averagePrice: statusRes.order.order.limitPx,
          timestamps: { submittedAt: new Date(statusRes.order.order.timestamp), resolvedAt: now }
        };
      }
    }

    // If completely absent from openOrders, fills, and status, the order was rejected before on-chain registration
    return {
      hedgeIntentId,
      cloid,
      venueOrderId,
      status: 'REJECTED',
      requestedQuantity: '0',
      executedQuantity: '0',
      remainingQuantity: '0',
      error: 'Order was not found in open orders, fills, or order status on venue',
      timestamps: { submittedAt: now, resolvedAt: now }
    };
  }

  public async getClearinghouseState(): Promise<HyperliquidClearinghouseState> {
    return this.client.getClearinghouseState();
  }

  public async getSpotClearinghouseState(): Promise<HyperliquidSpotClearinghouseState> {
    return this.client.getSpotClearinghouseState();
  }

  public async getOpenOrders(): Promise<any[]> {
    return this.client.getOpenOrders();
  }

  public async getL2Book(symbol: string): Promise<HyperliquidL2BookResponse> {
    const marketInfo = await this.resolveMarketInfo(symbol);
    return this.client.getL2Book(marketInfo.coin);
  }

  // ==========================================
  // 5. HELPER METHODS
  // ==========================================

  private mapOrderPlacementResult(
    request: HedgeOrderRequest,
    cloid: string,
    statusData: HyperliquidOrderPlacementStatus | string | undefined,
    submittedAt: Date,
    rawResponse: any
  ): HedgeOrderResult {
    const resolvedAt = new Date();

    if (!statusData) {
      return {
        hedgeIntentId: request.hedgeIntentId,
        cloid,
        status: 'UNKNOWN',
        requestedQuantity: request.quantity,
        executedQuantity: '0',
        remainingQuantity: request.quantity,
        rawVenueResponse: rawResponse,
        timestamps: { submittedAt, resolvedAt }
      };
    }

    if (typeof statusData === 'string') {
      return {
        hedgeIntentId: request.hedgeIntentId,
        cloid,
        status: 'REJECTED',
        requestedQuantity: request.quantity,
        executedQuantity: '0',
        remainingQuantity: request.quantity,
        error: statusData,
        rawVenueResponse: rawResponse,
        timestamps: { submittedAt, resolvedAt }
      };
    }

    if (statusData.error) {
      return {
        hedgeIntentId: request.hedgeIntentId,
        cloid,
        status: 'REJECTED',
        requestedQuantity: request.quantity,
        executedQuantity: '0',
        remainingQuantity: request.quantity,
        error: statusData.error,
        rawVenueResponse: rawResponse,
        timestamps: { submittedAt, resolvedAt }
      };
    }

    if (statusData.filled) {
      return {
        hedgeIntentId: request.hedgeIntentId,
        cloid,
        venueOrderId: statusData.filled.oid.toString(),
        status: 'FILLED',
        requestedQuantity: request.quantity,
        executedQuantity: statusData.filled.totalSz,
        remainingQuantity: '0',
        averagePrice: statusData.filled.avgPx,
        rawVenueResponse: rawResponse,
        timestamps: { submittedAt, resolvedAt }
      };
    }

    if (statusData.resting) {
      return {
        hedgeIntentId: request.hedgeIntentId,
        cloid,
        venueOrderId: statusData.resting.oid.toString(),
        status: 'OPEN',
        requestedQuantity: request.quantity,
        executedQuantity: '0',
        remainingQuantity: request.quantity,
        rawVenueResponse: rawResponse,
        timestamps: { submittedAt, resolvedAt }
      };
    }

    return {
      hedgeIntentId: request.hedgeIntentId,
      cloid,
      status: 'UNKNOWN',
      requestedQuantity: request.quantity,
      executedQuantity: '0',
      remainingQuantity: request.quantity,
      rawVenueResponse: rawResponse,
      timestamps: { submittedAt, resolvedAt }
    };
  }

  private formatQuantity(qtyStr: string, szDecimals: number): string {
    const trimmed = qtyStr.trim();
    if (!trimmed || trimmed === 'NaN') return '0';
    const parts = trimmed.split('.');
    const intPart = parts[0] || '0';
    let fracPart = parts[1] || '';
    if (szDecimals === 0) return intPart;
    if (fracPart.length > szDecimals) {
      fracPart = fracPart.slice(0, szDecimals);
    }
    return `${intPart}.${fracPart.padEnd(szDecimals, '0')}`;
  }
}
