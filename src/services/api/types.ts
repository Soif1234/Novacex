/**
 * API Types & DTO Definitions
 * Matches authoritative backend server controllers and models.
 */

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  code?: string;
  details?: unknown;
}

export interface SafeUser {
  id: string;
  email: string;
  role: 'USER' | 'ADMIN' | 'SUPPORT';
  accountStatus: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  displayName?: string;
  username?: string;
  createdAt: string;
  lastLoginAt?: string;
  accounts: Array<{
    id: string;
    type: 'SPOT' | 'FUTURES' | 'FUNDING';
  }>;
}

export interface AuthSessionResponse {
  user: SafeUser;
  accounts: Array<{
    id: string;
    type: 'SPOT' | 'FUTURES' | 'FUNDING';
  }>;
  sessionToken?: string;
}

export interface SignupDto {
  email: string;
  password?: string;
  username?: string;
  displayName?: string;
}

export interface LoginDto {
  email: string;
  password?: string;
}

export interface BalanceEntry {
  available: string;
  locked: string;
  total: string;
}

export type WalletBalancesMap = Record<string, BalanceEntry>;

export interface InternalTransferDto {
  fromAccountId: string;
  toAccountId: string;
  asset: string;
  amount: string;
}

export interface PaperWithdrawDto {
  accountId: string;
  asset: string;
  amount: string;
}

export interface LedgerTransactionEntity {
  id: string;
  accountId: string;
  transactionType: string;
  referenceId: string;
  description?: string;
  createdAt: string;
}

export interface CreateSpotOrderDto {
  accountId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price?: string;
  quantity: string;
  clientOrderId?: string;
  timeInForce?: string;
}

export interface OrderEntity {
  id: string;
  clientOrderId?: string;
  accountId: string;
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  side: 'BUY' | 'SELL';
  type: 'LIMIT' | 'MARKET';
  price?: string;
  quantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  lockedAmount: string;
  lockedAsset: string;
  status: 'NEW' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED';
  timeInForce: string;
  createdAt: string;
  updatedAt: string;
}

export interface TradeEntity {
  id: string;
  orderId: string;
  accountId: string;
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  quantity: string;
  quoteQuantity: string;
  fee: string;
  feeAsset: string;
  isMaker: boolean;
  createdAt: string;
}

export interface CreateFuturesOrderDto {
  accountId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionSide: 'LONG' | 'SHORT';
  type: 'LIMIT' | 'MARKET';
  price?: string;
  quantity: string;
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  reduceOnly?: boolean;
  closePosition?: boolean;
  clientOrderId?: string;
  timeInForce?: string;
}

export interface FuturesOrderEntity {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  leverage: number;
  marginMode: 'ISOLATED' | 'CROSS';
  reduceOnly: boolean;
  closePosition: boolean;
  createdAt: string;
}

export interface FuturesPositionEntity {
  id: string;
  accountId: string;
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
  status: 'OPEN' | 'CLOSED' | 'LIQUIDATED';
  createdAt: string;
  updatedAt: string;
}

export interface FuturesTpSlConfigEntity {
  id: string;
  positionId: string;
  accountId: string;
  symbol: string;
  positionSide: 'LONG' | 'SHORT';
  takeProfitEnabled: boolean;
  takeProfitPrice?: string;
  stopLossEnabled: boolean;
  stopLossPrice?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SetTpSlDto {
  takeProfitPrice?: string;
  stopLossPrice?: string;
}

export interface TickerData {
  symbol: string;
  lastPrice: string;
  high24h: string;
  low24h: string;
  volume24h: string;
  quoteVolume24h: string;
  priceChange24h: string;
  priceChangePercent: string;
  timestamp: number;
}

export interface OrderBookSnapshot {
  symbol: string;
  bids: [string, string][];
  asks: [string, string][];
  timestamp: number;
  sequence: number;
}

export interface MarkPriceData {
  symbol: string;
  markPrice: string;
  timestamp: number;
}
