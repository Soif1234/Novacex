export type MarginMode = 'ISOLATED' | 'CROSS';
export type PositionSide = 'LONG' | 'SHORT';
export type OrderSide = 'BUY' | 'SELL';
export type FuturesOrderType = 'MARKET' | 'LIMIT' | 'STOP_MARKET' | 'STOP_LIMIT';
export type FuturesOrderStatus = 'NEW' | 'PENDING' | 'FILLED' | 'CANCELLED' | 'REJECTED';

export interface FuturesMarket {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  // Dynamic
  lastPrice: string;
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  openInterest: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  change24h: string;
  // Static Config
  tickSize: string;
  quantityPrecision: number;
  minimumQuantity: string;
  maximumLeverage: number;
  makerFee: string;
  takerFee: string;
  maintenanceMarginRate: string;
}

export interface FuturesOrder {
  id: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  type: FuturesOrderType;
  reduceOnly?: boolean;
  closePosition?: boolean;
  price?: string;
  stopPrice?: string;
  isTriggered?: boolean;
  quantity: string;
  filledQuantity?: string;
  remainingQuantity?: string;
  status: FuturesOrderStatus;
  leverage: number;
  marginMode: MarginMode;
  createdAt: number;
  updatedAt: number;
}

export interface FuturesTrade {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  side: OrderSide;
  positionSide: PositionSide;
  price: string;
  quantity: string;
  fee: string;
  feeAsset: string;
  feeType?: 'MAKER' | 'TAKER';
  feeRate?: string;
  realizedPnl: string;
  timestamp: number;
}

export type PositionStatus = 'OPEN' | 'CLOSED' | 'LIQUIDATED';

export type TpSlStatus = 'ACTIVE' | 'TRIGGERED' | 'CANCELLED' | 'COMPLETED';

export interface TpSlConfiguration {
  tpSlId: string;
  accountId: string;
  positionId: string;
  symbol: string;
  positionSide: PositionSide;
  takeProfitEnabled: boolean;
  takeProfitPrice?: string;
  stopLossEnabled: boolean;
  stopLossPrice?: string;
  quantity: string;
  reduceOnly: boolean;
  status: TpSlStatus;
  triggerType?: 'TP' | 'SL'; // For history
  createdAt: number;
  updatedAt: number;
}



export interface FuturesPosition {
  positionId: string;
  accountId: string;
  symbol: string;
  side: PositionSide;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  leverage: number;
  marginMode: MarginMode;
  initialMargin: string;
  maintenanceMargin: string;
  unrealizedPnl: string;
  realizedPnl: string;
  liquidationPrice: string;
  status: PositionStatus;
  cumulativeFee?: string;
  cumulativeFunding?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FuturesCalculationResult {
  unrealizedPnl: string;
  pnlPercentage: string;
  marginRatio: string;
}

export interface FuturesLiquidation {
  liquidationId: string;
  accountId: string;
  positionId: string;
  symbol: string;
  side: PositionSide;
  quantity: string;
  markPrice: string;
  liquidationPrice: string;
  realizedPnl: string;
  fee: string;
  timestamp: number;
  reason: string;
}
