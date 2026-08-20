import { ExecutionPlan, OrderSlice, RoutingMode, LiquiditySource, LiquiditySourceType } from '../../models/liquidity.model';
import { AggregatedOrderBook, MarketDataSourceHealth } from './aggregator';
import { ProviderError, ProviderErrorCode } from './errors';

export interface ProviderFeeConfig {
  feeRate: number;
  slippageAssumed: number;
}

export interface RoutingConfig {
  maxExternalNotional?: number;
  maxExternalQuantity?: number;
  maxSlices?: number;
  enabledProviders: string[];
  providerConfigs: Record<string, ProviderFeeConfig>;
  maxPriceDeviationPct?: number;
}

export interface RouterRequest {
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT';
  quantity: string;
  limitPrice?: string;
  aggregatedOrderBook: AggregatedOrderBook;
  routingConfig: RoutingConfig;
}

interface VirtualLevel {
  sourceId: string;
  sourceType: LiquiditySourceType;
  rawPrice: number;
  effectivePrice: number;
  quantity: number;
  feeRate: number;
  slippageRate: number;
}

export class SmartOrderRouter {
  
  public routeOrder(request: RouterRequest): ExecutionPlan {
    this.validateRequest(request);

    const levels = this.buildVirtualOrderBook(request);
    
    // Sort levels for best effective price
    levels.sort((a, b) => {
      if (request.side === 'BUY') {
        return a.effectivePrice - b.effectivePrice; // Lowest cost first
      } else {
        return b.effectivePrice - a.effectivePrice; // Highest proceeds first
      }
    });

    const requestedQuantity = Number(request.quantity);
    let remainingQuantity = requestedQuantity;
    let externalAllocatedQty = 0;
    
    // Maps sourceId -> allocated data
    const allocations = new Map<string, {
      sourceType: LiquiditySourceType;
      quantity: number;
      costNotional: number;
      feesNotional: number;
      slippageNotional: number;
    }>();

    for (const level of levels) {
      if (remainingQuantity <= 0) break;

      let allocatable = level.quantity;

      // Price protection
      if (request.orderType === 'LIMIT' && request.limitPrice) {
        const limit = Number(request.limitPrice);
        if (request.side === 'BUY' && level.rawPrice > limit) continue;
        if (request.side === 'SELL' && level.rawPrice < limit) continue;
      }

      // External exposure limits
      if (level.sourceType === 'EXTERNAL') {
        const extLimit = request.routingConfig.maxExternalQuantity;
        if (extLimit !== undefined) {
          const availableExt = extLimit - externalAllocatedQty;
          if (availableExt <= 0) continue;
          allocatable = Math.min(allocatable, availableExt);
        }
      }

      const take = Math.min(allocatable, remainingQuantity);
      if (take <= 0) continue;

      remainingQuantity -= take;
      if (level.sourceType === 'EXTERNAL') {
        externalAllocatedQty += take;
      }

      const existing = allocations.get(level.sourceId) || {
        sourceType: level.sourceType,
        quantity: 0,
        costNotional: 0,
        feesNotional: 0,
        slippageNotional: 0
      };

      existing.quantity += take;
      existing.costNotional += take * level.rawPrice;
      existing.feesNotional += (take * level.rawPrice) * level.feeRate;
      existing.slippageNotional += (take * level.rawPrice) * level.slippageRate;
      allocations.set(level.sourceId, existing);
    }

    // Insufficient liquidity check
    // We enforce exact satisfaction of the requested quantity for routing purposes (no partial overall plans)
    // In a real system, partial might be allowed based on TIF, but here we enforce full routing capability for FOK/IOC assumptions.
    if (remainingQuantity > 0) {
      throw new ProviderError(
        ProviderErrorCode.INSUFFICIENT_LIQUIDITY,
        `Insufficient liquidity to fill ${request.quantity} ${request.symbol}`,
        'SMART_ROUTER'
      );
    }

    if (request.routingConfig.maxSlices && allocations.size > request.routingConfig.maxSlices) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Max slices exceeded', 'SMART_ROUTER');
    }

    const slices = this.buildSlices(allocations);
    const routingMode = this.determineRoutingMode(slices);

    let totalFees = 0;
    let totalSlippage = 0;
    let totalCostNotional = 0;

    for (const alloc of allocations.values()) {
      totalFees += alloc.feesNotional;
      totalSlippage += alloc.slippageNotional;
      totalCostNotional += alloc.costNotional;
    }

    const estimatedAveragePrice = totalCostNotional / requestedQuantity;

    return {
      planId: `plan-${Date.now()}-${Math.floor(Math.random()*1000)}`,
      routingMode,
      slices,
      estimatedQuantity: request.quantity,
      estimatedAveragePrice: estimatedAveragePrice.toFixed(8),
      estimatedFees: totalFees.toFixed(8),
      estimatedSlippage: totalSlippage.toFixed(8),
      createdAt: new Date()
    };
  }

  private validateRequest(request: RouterRequest) {
    if (Number(request.quantity) <= 0 || isNaN(Number(request.quantity))) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid quantity', 'SMART_ROUTER');
    }
    if (request.orderType !== 'MARKET' && request.orderType !== 'LIMIT') {
      throw new ProviderError(ProviderErrorCode.UNSUPPORTED_OPERATION, 'Order type not supported', 'SMART_ROUTER');
    }
    if (request.orderType === 'LIMIT' && (!request.limitPrice || Number(request.limitPrice) <= 0)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Limit price required and must be > 0', 'SMART_ROUTER');
    }
  }

  private buildVirtualOrderBook(request: RouterRequest): VirtualLevel[] {
    const levels: VirtualLevel[] = [];
    const sourceLevels = request.side === 'BUY' ? request.aggregatedOrderBook.asks : request.aggregatedOrderBook.bids;
    
    for (const lvl of sourceLevels) {
      const sourceMeta = request.aggregatedOrderBook.sources[lvl.sourceId];
      if (!sourceMeta || sourceMeta.health !== MarketDataSourceHealth.ACTIVE) continue;

      const isInternal = lvl.sourceId === 'INTERNAL';
      if (!isInternal && !request.routingConfig.enabledProviders.includes(lvl.sourceId)) {
        continue; // Source disabled
      }

      const config = request.routingConfig.providerConfigs[lvl.sourceId] || { feeRate: 0, slippageAssumed: 0 };
      const rawPrice = Number(lvl.price);
      
      let effectivePrice = rawPrice;
      if (request.side === 'BUY') {
        effectivePrice = rawPrice * (1 + config.feeRate + config.slippageAssumed);
      } else {
        effectivePrice = rawPrice * (1 - config.feeRate - config.slippageAssumed);
      }

      levels.push({
        sourceId: lvl.sourceId,
        sourceType: isInternal ? 'INTERNAL' : 'EXTERNAL',
        rawPrice,
        effectivePrice,
        quantity: Number(lvl.quantity),
        feeRate: config.feeRate,
        slippageRate: config.slippageAssumed
      });
    }

    return levels;
  }

  private buildSlices(allocations: Map<string, any>): OrderSlice[] {
    const slices: OrderSlice[] = [];
    let i = 1;
    for (const [sourceId, data] of allocations.entries()) {
      const source: LiquiditySource = {
        sourceId,
        sourceType: data.sourceType,
        venueId: sourceId,
        capabilities: []
      };

      const expectedAvg = data.costNotional / data.quantity;

      slices.push({
        sliceId: `slice-${Date.now()}-${i++}`,
        source,
        quantity: data.quantity.toFixed(8),
        expectedPrice: expectedAvg.toFixed(8),
        estimatedFee: data.feesNotional.toFixed(8),
        estimatedSlippage: data.slippageNotional.toFixed(8)
      });
    }
    return slices;
  }

  private determineRoutingMode(slices: OrderSlice[]): RoutingMode {
    let hasInternal = false;
    let hasExternal = false;
    for (const s of slices) {
      if (s.source.sourceType === 'INTERNAL') hasInternal = true;
      if (s.source.sourceType === 'EXTERNAL') hasExternal = true;
    }

    if (hasInternal && hasExternal) return 'SPLIT';
    if (hasExternal) return 'EXTERNAL_ONLY';
    return 'INTERNAL_ONLY';
  }
}
