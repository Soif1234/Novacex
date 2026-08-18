export type MarketType = 'SPOT' | 'FUTURES';
export type NormalizedOrderSide = 'BUY' | 'SELL' | 'LONG' | 'SHORT';
export type NormalizedOrderType = 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'TAKE_PROFIT' | 'TAKE_PROFIT_LIMIT';
export type NormalizedOrderStatus = 'NEW' | 'OPEN' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';

export interface Order {
    id: string;
    userId?: string;
    symbol: string;
    market: MarketType;
    side: NormalizedOrderSide;
    type: NormalizedOrderType;
    quantity: string;
    price?: string;
    stopPrice?: string;
    executedQuantity: string;
    remainingQuantity: string;
    averageFillPrice: string;
    status: NormalizedOrderStatus;
    timeInForce?: string;
    reduceOnly?: boolean;
    closePosition?: boolean;
    leverage?: number;
    fee: string;
    createdAt: number;
    updatedAt: number;
    completedAt?: number;
}

export interface TradeFill {
    id: string;
    orderId: string;
    userId?: string;
    symbol: string;
    market: MarketType;
    side: NormalizedOrderSide;
    quantity: string;
    price: string;
    fee: string;
    feeAsset: string;
    realizedPnl?: string;
    createdAt: number;
}
