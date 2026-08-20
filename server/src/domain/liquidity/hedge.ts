import { ProviderError, ProviderErrorCode } from './errors';
import { ExecutionStatus, LiquiditySource } from '../../models/liquidity.model';
import { ExposureGuard, ExposureDecision } from './exposure';
import { ExecutionEconomics } from './economics';

export type HedgeReason = 'INTERNAL_NET_EXPOSURE' | 'RISK_REDUCTION' | 'MANUAL_RISK_POLICY' | 'EXPOSURE_THRESHOLD' | 'REBALANCE';

export interface HedgePolicy {
  hedgeRatio: number; // e.g., 0.8 for 80%, 1.0 for 100%
  minHedgeQuantity: string;
  maxHedgeQuantity: string;
  minHedgeNotional: string;
  maxHedgeNotional: string;
}

export interface HedgeRequest {
  hedgeId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  referencePrice: string;
  notional: string;
  reason: HedgeReason;
  urgency: 'NORMAL' | 'HIGH';
  targetSource?: string;
  clientOrderId: string;
}

export interface HedgePlan {
  planId: string;
  request: HedgeRequest;
  selectedSource: LiquiditySource;
  plannedQuantity: string;
  expectedPrice: string;
  expectedFees: string;
  expectedSlippage: string;
}

export interface HedgeExecution {
  hedgeId: string;
  clientOrderId: string;
  providerId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: ExecutionStatus;
  requestedQuantity: string;
  executedQuantity: string;
  averagePrice: string;
  economics?: ExecutionEconomics;
}

export interface HedgeExposure {
  symbol: string;
  grossLongInternal: string;
  grossShortInternal: string;
  netInternalQuantity: string;
  netInternalSide: 'LONG' | 'SHORT' | 'FLAT';
  targetHedgeQuantity: string;
  targetHedgeSide: 'BUY' | 'SELL' | 'NONE';
  existingExecutedHedge: string;
  pendingHedge: string;
  residualHedgeRequirement: string;
}

export class FuturesHedgeManager {
  private exposureGuard: ExposureGuard;
  
  // State maps
  private executedHedgeQuantity: Map<string, number> = new Map(); // by symbol
  private pendingHedgeQuantity: Map<string, number> = new Map(); // by symbol
  private activeHedges: Map<string, HedgeExecution> = new Map(); // by hedgeId

  constructor(exposureGuard: ExposureGuard) {
    this.exposureGuard = exposureGuard;
  }

  public calculateHedgeExposure(
    symbol: string,
    internalLongQty: string,
    internalShortQty: string,
    policy: HedgePolicy
  ): HedgeExposure {
    const lQty = this.parseValidNumber(internalLongQty, 'internalLongQty');
    const sQty = this.parseValidNumber(internalShortQty, 'internalShortQty');

    const netInternal = lQty - sQty;
    const netSide = netInternal > 0 ? 'LONG' : (netInternal < 0 ? 'SHORT' : 'FLAT');
    
    // Target hedge side is opposite to net internal exposure
    const targetHedgeSide = netSide === 'LONG' ? 'SELL' : (netSide === 'SHORT' ? 'BUY' : 'NONE');
    
    // Target hedge quantity based on ratio
    let targetHedgeQuantity = Math.abs(netInternal) * policy.hedgeRatio;

    // Apply Min/Max thresholds
    const minQty = this.parseValidNumber(policy.minHedgeQuantity, 'minHedgeQuantity');
    const maxQty = this.parseValidNumber(policy.maxHedgeQuantity, 'maxHedgeQuantity');

    if (targetHedgeQuantity < minQty) {
      targetHedgeQuantity = 0;
    }
    if (targetHedgeQuantity > maxQty) {
      targetHedgeQuantity = maxQty;
    }

    const executed = this.executedHedgeQuantity.get(symbol) || 0;
    const pending = this.pendingHedgeQuantity.get(symbol) || 0;

    let residual = targetHedgeQuantity - executed - pending;
    if (residual < 0) residual = 0; // Prevent negative residual

    // If target is 0, residual is 0
    if (targetHedgeQuantity === 0) residual = 0;

    return {
      symbol,
      grossLongInternal: lQty.toFixed(8),
      grossShortInternal: sQty.toFixed(8),
      netInternalQuantity: Math.abs(netInternal).toFixed(8),
      netInternalSide: netSide,
      targetHedgeQuantity: targetHedgeQuantity.toFixed(8),
      targetHedgeSide: targetHedgeQuantity > 0 ? targetHedgeSide : 'NONE',
      existingExecutedHedge: executed.toFixed(8),
      pendingHedge: pending.toFixed(8),
      residualHedgeRequirement: residual.toFixed(8)
    };
  }

  public createHedgeRequest(
    hedgeId: string,
    exposure: HedgeExposure,
    referencePrice: string,
    providerId: string,
    policy: HedgePolicy
  ): HedgeRequest | null {
    if (exposure.targetHedgeSide === 'NONE' || Number(exposure.residualHedgeRequirement) === 0) {
      return null;
    }

    const refPrice = this.parseValidNumber(referencePrice, 'referencePrice');
    const residual = Number(exposure.residualHedgeRequirement);
    const notional = residual * refPrice;

    // Check notional bounds
    const minNotional = this.parseValidNumber(policy.minHedgeNotional, 'minHedgeNotional');
    const maxNotional = this.parseValidNumber(policy.maxHedgeNotional, 'maxHedgeNotional');

    if (notional < minNotional) {
      return null;
    }
    
    let finalQty = residual;
    let finalNotional = notional;
    if (notional > maxNotional) {
       finalNotional = maxNotional;
       finalQty = finalNotional / refPrice;
    }

    // Check Exposure Limits
    const decision: ExposureDecision = this.exposureGuard.canRoute({
      providerId,
      symbol: exposure.symbol || 'UNKNOWN',
      notional: finalNotional.toString(),
      quantity: finalQty.toString()
    });

    if (!decision.allowed) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Hedge rejected by ExposureGuard: ${decision.reason}`, 'HEDGE');
    }

    return {
      hedgeId,
      symbol: exposure.symbol || 'UNKNOWN',
      side: exposure.targetHedgeSide as 'BUY' | 'SELL',
      quantity: finalQty.toFixed(8),
      referencePrice: refPrice.toFixed(8),
      notional: finalNotional.toFixed(8),
      reason: 'INTERNAL_NET_EXPOSURE',
      urgency: 'NORMAL',
      targetSource: providerId,
      clientOrderId: `hedge-${hedgeId}`
    };
  }

  public async submitHedge(request: HedgeRequest) {
    if (this.activeHedges.has(request.hedgeId)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Duplicate hedgeId', 'HEDGE');
    }

    // Reserve exposure
    await this.exposureGuard.reserveExposure(request.hedgeId, {
      providerId: request.targetSource!,
      symbol: request.symbol,
      notional: request.notional,
      quantity: request.quantity
    });

    const qty = Number(request.quantity);
    this.pendingHedgeQuantity.set(request.symbol, (this.pendingHedgeQuantity.get(request.symbol) || 0) + qty);

    this.activeHedges.set(request.hedgeId, {
      hedgeId: request.hedgeId,
      clientOrderId: request.clientOrderId,
      providerId: request.targetSource!,
      symbol: request.symbol,
      side: request.side,
      status: 'SUBMITTED',
      requestedQuantity: request.quantity,
      executedQuantity: '0',
      averagePrice: '0'
    });
  }

  public async applyHedgeExecution(hedgeId: string, executedQuantity: string, averagePrice: string, status: ExecutionStatus) {
    const hedge = this.activeHedges.get(hedgeId);
    if (!hedge) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Unknown hedgeId', 'HEDGE');
    }

    const requested = Number(hedge.requestedQuantity);
    let execQty = this.parseValidNumber(executedQuantity, 'executedQuantity');
    const avgPrice = this.parseValidNumber(averagePrice, 'averagePrice');

    // Over-hedge protection
    if (execQty > requested) {
      execQty = requested;
    }

    const prevExec = Number(hedge.executedQuantity);
    const newExecDiff = execQty - prevExec;

    // Apply to Exposure Guard
    const notionalDiff = newExecDiff * avgPrice;
    await this.exposureGuard.applyExecution(hedgeId, notionalDiff.toString(), newExecDiff.toString(), status);

    hedge.status = status;
    hedge.executedQuantity = execQty.toFixed(8);
    hedge.averagePrice = avgPrice.toFixed(8);

    // Terminal Status handling
    const isTerminal = ['FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED', 'FAILED'].includes(status);
    
    if (isTerminal) {
       // Decrement pending
       this.pendingHedgeQuantity.set(hedge.symbol, Math.max(0, (this.pendingHedgeQuantity.get(hedge.symbol) || 0) - requested));
       
       // Increment executed (if filled/partial fill)
       if (execQty > 0) {
         this.executedHedgeQuantity.set(hedge.symbol, (this.executedHedgeQuantity.get(hedge.symbol) || 0) + execQty);
       }
    } else if (status === 'UNKNOWN' || status === 'RECONCILING') {
       // UNKNOWN preserves pending state. Does not retry blindly.
       // The pending quantity remains accounted for, preventing duplicate hedges.
    }
  }

  public attachEconomics(hedgeId: string, economics: ExecutionEconomics) {
    const hedge = this.activeHedges.get(hedgeId);
    if (!hedge) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Unknown hedgeId', 'HEDGE');
    }
    hedge.economics = economics;
  }

  public getHedge(hedgeId: string): HedgeExecution | undefined {
    return this.activeHedges.get(hedgeId);
  }

  private parseValidNumber(val: string, label: string): number {
    const n = Number(val);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `INVALID_${label.toUpperCase()}`, 'HEDGE');
    }
    return n;
  }
}
