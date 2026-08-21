export type MarketType = 'SPOT' | 'FUTURES';
export type OrderSide = 'BUY' | 'SELL';
export type OrderType = 'LIMIT' | 'MARKET' | 'STOP_LIMIT' | 'TAKE_PROFIT_LIMIT';
export type OrderStatus = 'UNTRIGGERED' | 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export interface TradingPairEntity {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  marketType: MarketType;
  tickSize: string;
  lotSize: string;
  minNotional: string;
  makerFeeRate: string;
  takerFeeRate: string;
  isActive: boolean;
  createdAt: Date;
}

export interface OrderEntity {
  id: string;
  clientOrderId?: string;
  accountId: string;
  market: MarketType;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price?: string;
  stopPrice?: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  lockedAmount: string;
  lockedAsset: string;
  status: OrderStatus;
  timeInForce: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface TradeEntity {
  id: string;
  orderId: string;
  accountId: string;
  market: MarketType;
  symbol: string;
  side: OrderSide;
  price: string;
  quantity: string;
  quoteQuantity: string;
  fee: string;
  feeAsset: string;
  isMaker: boolean;
  counterpartyOrderId?: string;
  createdAt: Date;
}
