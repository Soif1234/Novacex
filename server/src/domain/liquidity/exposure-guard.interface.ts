export type ExposureDecisionResult = 'ALLOW' | 'REDUCE_SIZE' | 'REJECT' | 'REDUCE_ONLY' | 'HALT';

export interface ExposureDecision {
  result: ExposureDecisionResult;
  reason: string;
  allowedQuantity?: string; // Only if REDUCE_SIZE is returned
}

export interface ExposureGuardInputs {
  currentHouseExposure: string;
  pendingHedgeQuantity: string;
  externalPosition: string;
  pendingExternalOrdersQuantity: string;
  market: string;
  marketDataFreshness: 'HEALTHY' | 'STALE' | 'DEGRADED' | 'DISCONNECTED';
  proposedHedgeSide: 'BUY' | 'SELL';
  hyperliquidReduceOnly: boolean;
  hyperliquidHedgeHalt: boolean;
}

export interface RiskLimits {
  maxHouseExposure: string;
  maxHedgeSize: string;
  maxExternalPosition: string;
  maxOutstandingHedgeOrders: string;
}

export interface IExposureGuard {
  evaluateHedge(inputs: ExposureGuardInputs, limits: RiskLimits): ExposureDecision;
}
