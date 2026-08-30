export type HedgeIntentStatus =
  | 'CREATED'
  | 'APPROVED'
  | 'SUBMITTING'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'FAILED'
  | 'UNKNOWN_PENDING_RECONCILIATION'
  | 'RECONCILIATION_REQUIRED';

export type HedgeReason =
  | 'INTERNAL_NET_EXPOSURE'
  | 'RISK_REDUCTION'
  | 'MANUAL_RISK_POLICY'
  | 'EXPOSURE_THRESHOLD'
  | 'REBALANCE';

export interface HedgeIntent {
  hedgeIntentId: string;
  market: string;
  side: 'BUY' | 'SELL';
  requestedQuantity: string;
  remainingQuantity: string;
  targetExposure: string;
  reason: HedgeReason;
  createdAt: Date;
  status: HedgeIntentStatus;
  externalOrderId?: string;
  cloid: string;
}

export interface IFuturesHedgeManager {
  processCustomerFill(market: string, side: 'BUY' | 'SELL', qty: string, price: string): Promise<void>;
  evaluateNettingWindow(): Promise<void>;
  createHedgeIntent(market: string, side: 'BUY' | 'SELL', quantity: string, reason: HedgeReason, targetExposure: string): Promise<HedgeIntent>;
  executeHedgeIntent(intent: HedgeIntent): Promise<void>;
  recoverUnknownOrders(): Promise<void>;
}
