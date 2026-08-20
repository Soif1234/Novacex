export type RoutingMode = 'INTERNAL_ONLY' | 'EXTERNAL_ONLY' | 'SPLIT';

export type LiquiditySourceType = 'INTERNAL' | 'EXTERNAL';

export interface LiquiditySource {
  sourceId: string;
  sourceType: LiquiditySourceType;
  venueId: string;
  capabilities: string[];
}

export interface ExecutionVenue {
  venueId: string;
  venueType: string;
  source: LiquiditySource;
  capabilities: string[];
}

export interface LiquidityQuote {
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  quantity: string;
  fee: string;
  slippage: string;
  source: LiquiditySource;
  timestamp: Date;
}

export interface OrderSlice {
  sliceId: string;
  source: LiquiditySource;
  quantity: string;
  expectedPrice: string;
  estimatedFee: string; // Captures provider fee, NovaCEX fee, network/gas cost
  estimatedSlippage: string;
}

export interface ExecutionPlan {
  planId: string;
  routingMode: RoutingMode;
  slices: OrderSlice[];
  estimatedQuantity: string;
  estimatedAveragePrice: string;
  estimatedFees: string;
  estimatedSlippage: string;
  createdAt: Date;
}

export type ExecutionStatus = 
  | 'CREATED'
  | 'VALIDATED'
  | 'RESERVED'
  | 'ROUTING'
  | 'SUBMITTED'
  | 'ACKNOWLEDGED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCEL_PENDING'
  | 'CANCELLED'
  | 'REJECTED'
  | 'FAILED'
  | 'UNKNOWN'
  | 'RECONCILING'
  | 'CONFIRMED';

export interface ProviderExecution {
  executionId: string;
  providerOrderId: string;
  source: LiquiditySource;
  status: ExecutionStatus;
  requestedQuantity: string;
  executedQuantity: string;
  averagePrice: string;
  fee: string;
  externalReference: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  executedQuantity: string;
  averagePrice: string;
  fees: string;
  slippage: string;
  providerReference: string;
  reconciliationRequired: boolean;
}
