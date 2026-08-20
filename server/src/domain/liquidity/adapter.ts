import { ExecutionStatus } from '../../models/liquidity.model';

export enum ProviderCapability {
  SPOT = 'SPOT',
  FUTURES = 'FUTURES',
  MARKET_ORDER = 'MARKET_ORDER',
  LIMIT_ORDER = 'LIMIT_ORDER',
  ORDER_CANCEL = 'ORDER_CANCEL',
  ORDER_STATUS = 'ORDER_STATUS',
  ORDER_BOOK = 'ORDER_BOOK',
  TICKER = 'TICKER',
  TRADES = 'TRADES',
  PRIVATE_STREAM = 'PRIVATE_STREAM',
  PUBLIC_STREAM = 'PUBLIC_STREAM',
  PARTIAL_FILLS = 'PARTIAL_FILLS',
  CLIENT_ORDER_ID = 'CLIENT_ORDER_ID'
}

export interface NormalizedTicker {
  symbol: string;
  bid: string;
  ask: string;
  lastPrice: string;
  volume24h: string;
  timestamp: Date;
}

export interface NormalizedOrderBookLevel {
  price: string;
  quantity: string;
}

export interface NormalizedOrderBook {
  symbol: string;
  bids: NormalizedOrderBookLevel[];
  asks: NormalizedOrderBookLevel[];
  timestamp: Date;
}

export interface NormalizedTrade {
  tradeId: string;
  symbol: string;
  price: string;
  quantity: string;
  side: 'BUY' | 'SELL';
  timestamp: Date;
}

export interface NormalizedOrderRequest {
  clientOrderId: string; // Mandatory idempotency key
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT';
  quantity: string;
  price?: string;
  timeInForce?: 'GTC' | 'IOC' | 'FOK';
  reduceOnly?: boolean;
  metadata?: Record<string, any>;
}

export interface NormalizedExecutionResponse {
  providerOrderId: string;
  clientOrderId: string;
  status: ExecutionStatus;
  executedQuantity: string;
  remainingQuantity: string;
  averagePrice: string;
  fee: string;
  feeAsset: string;
  providerReference: string;
  timestamps: {
    created: Date;
    updated: Date;
  };
  errorInformation?: string;
}

/**
 * Backend-only credential abstraction.
 * This interface isolates secrets from the core domain.
 */
export interface ProviderCredentials {
  apiKey?: string;
  apiSecret?: string;
  passphrase?: string;
  [key: string]: string | undefined;
}

export interface ILiquidityProviderAdapter {
  readonly providerId: string;
  
  getCapabilities(): ProviderCapability[];
  hasCapability(capability: ProviderCapability): boolean;
  
  healthCheck(): Promise<boolean>;
  
  getTicker(symbol: string): Promise<NormalizedTicker>;
  getOrderBook(symbol: string, depth?: number): Promise<NormalizedOrderBook>;
  getTrades(symbol: string): Promise<NormalizedTrade[]>;
  
  getBalances(): Promise<Record<string, string>>;
  placeOrder(request: NormalizedOrderRequest): Promise<NormalizedExecutionResponse>;
  cancelOrder(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse>;
  getOrderStatus(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse>;
}
