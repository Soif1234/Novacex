import * as crypto from 'crypto';
import { 
  ILiquidityProviderAdapter, 
  ProviderCapability, 
  NormalizedOrderRequest, 
  NormalizedExecutionResponse,
  NormalizedTicker,
  NormalizedOrderBook,
  NormalizedTrade,
  ProviderCredentials
} from './adapter';
import { ExecutionStatus } from '../../models/liquidity.model';
import { ProviderError, ProviderErrorCode } from './errors';

export interface HyperliquidAdapterConfig {
  env: string;
  baseUrl: string;
  market: 'SPOT' | 'FUTURES';
  credentials?: ProviderCredentials;
}

export class HyperliquidAdapter implements ILiquidityProviderAdapter {
  public readonly providerId: string;
  private readonly baseUrl: string;
  private readonly market: 'SPOT' | 'FUTURES';
  private readonly capabilities: Set<ProviderCapability>;

  constructor(private config: HyperliquidAdapterConfig) {
    this.providerId = `HYPERLIQUID_${config.market}`;
    this.market = config.market;

    if (config.env !== 'testnet' && config.env !== 'sandbox') {
      throw new ProviderError(
        ProviderErrorCode.AUTHORIZATION_FAILURE, 
        'Adapter refuses to start outside TESTNET environment.', 
        this.providerId
      );
    }
    
    // Explicit mainnet guard
    if (config.baseUrl.includes('api.hyperliquid.xyz') && !config.baseUrl.includes('testnet')) {
      throw new ProviderError(
        ProviderErrorCode.AUTHORIZATION_FAILURE, 
        'Adapter refuses to connect to mainnet endpoint.', 
        this.providerId
      );
    }
    
    this.baseUrl = config.baseUrl;

    this.capabilities = new Set([
      this.market === 'SPOT' ? ProviderCapability.SPOT : ProviderCapability.FUTURES,
      ProviderCapability.MARKET_ORDER,
      ProviderCapability.LIMIT_ORDER,
      ProviderCapability.ORDER_CANCEL,
      ProviderCapability.ORDER_STATUS,
      ProviderCapability.ORDER_BOOK,
      ProviderCapability.TICKER,
      ProviderCapability.CLIENT_ORDER_ID
    ]);
  }

  public getCapabilities(): ProviderCapability[] {
    return Array.from(this.capabilities);
  }

  public hasCapability(capability: ProviderCapability): boolean {
    return this.capabilities.has(capability);
  }

  public async healthCheck(): Promise<boolean> {
    try {
      const res = await this.publicRequest({ type: 'meta' });
      return res != null;
    } catch {
      return false;
    }
  }

  public async getTicker(symbol: string): Promise<NormalizedTicker> {
    try {
      // Hyperliquid provides metaAndAssetCtxs for all assets
      const payload = await this.publicRequest({ type: 'metaAndAssetCtxs' });
      
      if (!Array.isArray(payload) || payload.length < 2) {
         throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid ticker response from provider', this.providerId);
      }

      // Simplified mock mapping for domain test purposes
      return {
        symbol,
        bid: '0', // Real implementation maps from context
        ask: '0',
        lastPrice: '0',
        volume24h: '0',
        timestamp: new Date()
      };
    } catch (err: any) {
      throw this.handleProviderError(err);
    }
  }

  public async getOrderBook(symbol: string, depth = 100): Promise<NormalizedOrderBook> {
    try {
      const payload = await this.publicRequest({ type: 'l2Book', coin: this.formatSymbol(symbol) });

      if (!payload || !Array.isArray(payload.levels)) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid orderbook response', this.providerId);
      }

      // Mock format mapped to Hyperliquid's [ [px, sz, n], ... ]
      return {
        symbol,
        bids: payload.levels[0]?.map((b: any) => ({ price: b.px, quantity: b.sz })) || [],
        asks: payload.levels[1]?.map((a: any) => ({ price: a.px, quantity: a.sz })) || [],
        timestamp: new Date()
      };
    } catch (err: any) {
      throw this.handleProviderError(err);
    }
  }

  public async getTrades(symbol: string): Promise<NormalizedTrade[]> {
    throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Not implemented for Phase 5.14', this.providerId);
  }

  public async getBalances(): Promise<Record<string, string>> {
    try {
      // Typically /info { type: "clearinghouseState", user: address }
      // This is a placeholder since we are strictly offline in tests if no address is provided
      if (!this.config.credentials?.walletAddress) {
        throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'Missing walletAddress', this.providerId);
      }
      
      const payload = await this.publicRequest({ 
        type: this.market === 'SPOT' ? 'spotClearinghouseState' : 'clearinghouseState',
        user: this.config.credentials.walletAddress
      });
      
      return {}; // Real implementation parses margin summary and balances
    } catch (err: any) {
      throw this.handleProviderError(err);
    }
  }

  public async placeOrder(request: NormalizedOrderRequest): Promise<NormalizedExecutionResponse> {
    // Prevent cross-market contamination at the adapter boundary
    if (this.market === 'SPOT' && request.metadata?.isFutures) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Futures operation rejected by Spot adapter.', this.providerId);
    }
    if (this.market === 'FUTURES' && request.metadata?.isSpot) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Spot operation rejected by Futures adapter.', this.providerId);
    }

    try {
      // Hyperliquid uses 'cloid' - 16 bytes hex.
      const cloid = this.generateCloid(request.clientOrderId);
      
      const action = {
        type: 'order',
        orders: [{
          coin: this.formatSymbol(request.symbol),
          is_buy: request.side === 'BUY',
          sz: parseFloat(request.quantity),
          limit_px: parseFloat(request.price || '0'),
          order_type: { limit: { tif: request.timeInForce === 'IOC' ? 'Ioc' : 'Alo' } },
          reduce_only: request.reduceOnly || false,
          cloid
        }],
        grouping: 'na'
      };

      const payload = await this.signedRequest(action);
      return this.normalizeExecutionResponse(request.clientOrderId, payload);
    } catch (err: any) {
      if (err.message && err.message.includes('timeout')) {
        throw new ProviderError(ProviderErrorCode.TIMEOUT, 'UNKNOWN', this.providerId);
      }
      throw this.handleProviderError(err);
    }
  }

  public async cancelOrder(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse> {
    try {
      const action = {
        type: 'cancel',
        cancels: [{
          coin: this.formatSymbol(symbol),
          oid: parseInt(providerOrderId, 10)
        }]
      };
      const payload = await this.signedRequest(action);
      return this.normalizeExecutionResponse('unknown', payload); // cloid typically not returned on pure cancel
    } catch (err: any) {
      if (err.message && err.message.includes('timeout')) {
        throw new ProviderError(ProviderErrorCode.TIMEOUT, 'UNKNOWN', this.providerId);
      }
      throw this.handleProviderError(err);
    }
  }

  public async getOrderStatus(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse> {
    try {
      if (!this.config.credentials?.walletAddress) {
        throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'Missing walletAddress', this.providerId);
      }
      const payload = await this.publicRequest({
        type: 'orderStatus',
        user: this.config.credentials.walletAddress,
        oid: parseInt(providerOrderId, 10)
      });
      return this.normalizeExecutionResponse('unknown', payload);
    } catch (err: any) {
      throw this.handleProviderError(err);
    }
  }

  // ==== PRIVATE UTILS ====

  private formatSymbol(symbol: string): string {
    // Hyperliquid internal coin strings, e.g. "BTC" for Futures, "@1" or "PURR/USDC" for Spot
    // For this mock, we just strip slashes.
    return symbol.replace('/', '');
  }

  private generateCloid(clientOrderId: string): string {
    // Hyperliquid requires a 128-bit (16-byte) hex string, typically 32 characters prefixed with 0x.
    // Instead of assuming MD5, we deterministically hash the clientOrderId using SHA-256 
    // and truncate to the required 128 bits (32 hex characters) to avoid collisions and preserve idempotency.
    if (!clientOrderId || clientOrderId.trim() === '') {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'clientOrderId cannot be empty', this.providerId);
    }
    
    const hash = crypto.createHash('sha256').update(clientOrderId).digest('hex');
    const cloid = `0x${hash.substring(0, 32)}`;
    
    // Strict validation to ensure it meets Hyperliquid requirements
    if (!/^0x[0-9a-f]{32}$/i.test(cloid)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Invalid cloid generated: ${cloid}`, this.providerId);
    }
    
    return cloid;
  }

  private normalizeExecutionResponse(clientOrderId: string, payload: any): NormalizedExecutionResponse {
    let status: ExecutionStatus = 'UNKNOWN';
    
    // Hyperliquid specific mapping (simplified for domain structure)
    // status is typically returned in orderStatus payload.status (e.g. 'filled', 'open', 'canceled')
    const providerStatus = payload?.status?.toLowerCase() || payload?.response?.type?.toLowerCase();

    if (providerStatus === 'open') status = 'ACKNOWLEDGED';
    if (providerStatus === 'filled') status = 'FILLED';
    if (providerStatus === 'canceled' || providerStatus === 'cancel') status = 'CANCELLED';
    if (providerStatus === 'rejected') status = 'REJECTED';
    
    // If it's a direct placeOrder response, status is inside response.data.statuses
    if (payload?.response?.data?.statuses?.[0]) {
       const stat = payload.response.data.statuses[0];
       if (stat.resting || stat.filled) {
           status = stat.filled ? 'FILLED' : 'ACKNOWLEDGED';
       } else if (stat.error) {
           status = 'REJECTED';
       }
    }

    return {
      providerOrderId: payload.order?.oid?.toString() || payload.response?.data?.statuses?.[0]?.resting?.oid?.toString() || '',
      clientOrderId: payload.order?.cloid || clientOrderId,
      status,
      executedQuantity: payload.order?.sz || '0', // Adjust based on real API
      remainingQuantity: '0',
      averagePrice: payload.order?.limit_px || '0',
      fee: '0', 
      feeAsset: 'USDC',
      providerReference: '',
      timestamps: {
        created: new Date(),
        updated: new Date()
      }
    };
  }

  private async publicRequest(payload: any): Promise<any> {
    const url = `${this.baseUrl}/info`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const data: any = await res.json();
      return data;
    } catch (err: any) {
      if (err.name === 'AbortError') throw new Error('timeout');
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async signedRequest(action: any): Promise<any> {
    if (!this.config.credentials?.privateKey) {
      throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'Missing credentials', this.providerId);
    }

    const url = `${this.baseUrl}/exchange`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    try {
      // In a real implementation, this requires EIP-712 signing over the action object.
      // We simulate the boundary by injecting a mock signature if offline.
      const signature = crypto.createHash('sha256').update(JSON.stringify(action)).digest('hex');
      
      const body = {
        action,
        nonce: Date.now(),
        signature,
        vaultAddress: null
      };

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      const payload: any = await res.json();
      if (!res.ok) {
        throw { status: res.status, payload };
      }
      return payload;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error('timeout');
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  public handleProviderError(err: any): ProviderError {
    if (err instanceof ProviderError) return err;

    const msg = err.payload?.msg || err.message || 'Unknown provider error';

    let mappedCode = ProviderErrorCode.PROVIDER_UNAVAILABLE;
    
    if (err.status === 429) {
      mappedCode = ProviderErrorCode.RATE_LIMIT;
    } else if (err.status === 401 || err.status === 403) {
      mappedCode = ProviderErrorCode.AUTHORIZATION_FAILURE;
    } else if (err.status >= 400 && err.status < 500) {
      mappedCode = ProviderErrorCode.INVALID_REQUEST;
    }

    const cleanMessage = msg
      .replace(new RegExp(this.config.credentials?.privateKey || 'PRIVATE_KEY', 'gi'), '[REDACTED]')
      .replace(new RegExp(this.config.credentials?.walletAddress || 'WALLET_ADDRESS', 'gi'), '[REDACTED]');

    return new ProviderError(mappedCode, cleanMessage, this.providerId);
  }
}
