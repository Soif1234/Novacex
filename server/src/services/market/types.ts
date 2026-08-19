/**
 * Market Data Contracts & Event Schema
 * Strictly enforces exact decimal string representations for all monetary values.
 * Zero floating-point numbers in event payloads.
 */

export type OrderBookLevel = [price: string, quantity: string];

export interface OrderBookSnapshot {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  sequence: number;
  epoch: number;
  timestamp: number;
}

export interface OrderBookUpdate {
  symbol: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  sequence: number;
  prevSequence: number;
  epoch: number;
  timestamp: number;
}

export interface TickerData {
  symbol: string;
  lastPrice: string;
  bid: string;
  ask: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  priceChange24h: string;
  priceChangePercent24h: string;
  timestamp: number;
}

export interface MarketTradeData {
  tradeId: string;
  symbol: string;
  price: string;
  quantity: string;
  quoteQuantity: string;
  side: 'BUY' | 'SELL';
  isMaker: boolean;
  timestamp: number;
}

export interface MarkPriceData {
  symbol: string;
  price: string;
  indexPrice?: string;
  fundingRate?: string;
  nextFundingTime?: number;
  timestamp: number;
}

export interface MarketStatusData {
  symbol: string;
  status: 'TRADING' | 'HALTED' | 'CLOSED';
  timestamp: number;
}

export interface UserOrderEventData {
  orderId: string;
  clientOrderId?: string;
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide?: 'LONG' | 'SHORT';
  type: string;
  price?: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  status: string;
  timeInForce: string;
  createdAt: number;
  updatedAt: number;
}

export interface UserTradeEventData {
  tradeId: string;
  orderId: string;
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide?: 'LONG' | 'SHORT';
  price: string;
  quantity: string;
  quoteQuantity: string;
  fee: string;
  feeAsset: string;
  isMaker: boolean;
  realizedPnl?: string;
  timestamp: number;
}

export interface UserBalanceEventData {
  accountId: string;
  accountType: string;
  asset: string;
  availableBalance: string;
  lockedBalance: string;
  totalBalance: string;
  changeAmount?: string;
  transactionType?: string;
  referenceId?: string;
  timestamp: number;
}

export interface UserPositionEventData {
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  quantity: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  initialMargin: string;
  maintenanceMargin: string;
  realizedPnl: string;
  unrealizedPnl?: string;
  status: 'OPEN' | 'CLOSED' | 'LIQUIDATED';
  timestamp: number;
}

/**
 * Standardized System Event Envelope
 */
export interface MarketEvent<T = unknown> {
  id: string; // Unique/deterministic event UUID
  type: string; // e.g. 'market.ticker', 'spot.order.created', 'wallet.balance.updated'
  channel?: string; // e.g. 'ticker:BTCUSDT', 'user:orders'
  userId?: string; // Internal owner identifier for private routing (never exposed on public streams)
  symbol?: string;
  sequence?: number; // Monotonic sequence for ordered market streams
  epoch?: number; // Restart epoch number
  timestamp: number;
  version: string; // '1.0.0'
  payload: T;
}

/**
 * Client-facing subscription request protocol
 */
export interface ClientWsMessage {
  type: 'subscribe' | 'unsubscribe' | 'auth' | 'ping';
  channel?: string;
  token?: string;
}

export interface ServerWsMessage {
  type: 'subscribed' | 'unsubscribed' | 'auth_success' | 'auth_failed' | 'pong' | 'event' | 'snapshot' | 'error';
  channel?: string;
  code?: string;
  message?: string;
  timestamp?: number;
  data?: unknown;
}
