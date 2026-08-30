/**
 * Hyperliquid Official API Types & Normalized Liquidity Interfaces
 * Phase 10.5 â€” Step 10.5-2
 */

// ==========================================
// 1. OFFICIAL INFO API SCHEMAS (/info)
// ==========================================

export interface HyperliquidPerpAssetMeta {
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated?: boolean;
  isCloseOnly?: boolean;
}

export interface HyperliquidSpotAssetMeta {
  name: string;
  tokens: [number, number]; // [baseTokenIndex, quoteTokenIndex]
  index: number;
  isCanonical: boolean;
}

export interface HyperliquidMetaResponse {
  universe: HyperliquidPerpAssetMeta[];
}

export interface HyperliquidSpotMetaResponse {
  tokens: { name: string; szDecimals: number; weiDecimals: number; index: number; tokenId: string; isCanonical: boolean }[];
  universe: HyperliquidSpotAssetMeta[];
}

export interface HyperliquidL2BookLevel {
  px: string;
  sz: string;
  n: number; // number of orders
}

export interface HyperliquidL2BookResponse {
  coin: string;
  time: number;
  levels: [HyperliquidL2BookLevel[], HyperliquidL2BookLevel[]]; // [bids, asks]
}

export interface HyperliquidPosition {
  coin: string;
  szi: string; // signed size: positive = long, negative = short
  entryPx: string;
  positionValue: string;
  unrealizedPnl: string;
  returnOnEquity: string;
  liquidationPx: string | null;
  leverage: {
    type: 'cross' | 'isolated';
    value: number;
    rawUsd?: string;
  };
  marginUsed: string;
  maxLeverage: number;
  cumFunding: {
    allTime: string;
    sinceOpen: string;
    sinceChange: string;
  };
}

export interface HyperliquidClearinghouseState {
  marginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
    withdrawable: string;
  };
  crossMarginSummary: {
    accountValue: string;
    totalMarginUsed: string;
    totalNtlPos: string;
    totalRawUsd: string;
    withdrawable: string;
  };
  assetPositions: {
    type: 'oneWay';
    position: HyperliquidPosition;
  }[];
  time: number;
}

export interface HyperliquidSpotBalance {
  coin: string;
  token: number;
  total: string;
  hold: string;
  entryNtl: string;
}

export interface HyperliquidSpotClearinghouseState {
  balances: HyperliquidSpotBalance[];
}

export interface HyperliquidOpenOrder {
  coin: string;
  side: 'B' | 'A'; // 'B' = Buy/Bid, 'A' = Ask/Sell
  limitPx: string;
  sz: string;
  oid: number;
  timestamp: number;
  origSz: string;
  cloid?: string;
}

export interface HyperliquidUserFill {
  closedPnl: string;
  coin: string;
  crossMargin: boolean;
  dir: string; // e.g. "Open Long", "Close Short"
  hash: string;
  oid: number;
  px: string;
  side: 'B' | 'A';
  startPosition: string;
  sz: string;
  time: number;
  fee: string;
  feeToken: string;
  tid: number;
  cloid?: string;
}

export type HyperliquidOrderStatusValue =
  | { status: 'open'; order: HyperliquidOpenOrder }
  | { status: 'filled'; order: HyperliquidOpenOrder }
  | { status: 'canceled' }
  | { status: 'triggered'; order: HyperliquidOpenOrder }
  | { status: 'rejected'; reason: string }
  | { status: 'marginCanceled' }
  | { status: 'unknownOid' };

export interface HyperliquidOrderStatusResponse {
  status: 'order' | 'unknownOid';
  order?: {
    order: HyperliquidOpenOrder;
    status: string;
    statusTimestamp: number;
  };
}

// ==========================================
// 2. OFFICIAL EXCHANGE API SCHEMAS (/exchange)
// ==========================================

export type HyperliquidTif = 'Gtc' | 'Ioc' | 'Alo';

export interface HyperliquidLimitOrderType {
  limit: {
    tif: HyperliquidTif;
  };
}

export interface HyperliquidTriggerOrderType {
  trigger: {
    isMarket: boolean;
    triggerPx: string;
    tpsl: 'tp' | 'sl';
  };
}

export type HyperliquidOrderTypeSpec = HyperliquidLimitOrderType | HyperliquidTriggerOrderType;

export interface HyperliquidOrderWire {
  a: number; // asset index (0 for BTC perp, 10000+ for spot)
  b: boolean; // is_buy: true = Buy, false = Sell
  p: string; // limit price as string
  s: string; // size as string
  r: boolean; // reduce_only
  t: HyperliquidOrderTypeSpec; // order type
  c?: string; // cloid: 16-byte hex string (0x...)
}

export interface HyperliquidOrderAction {
  type: 'order';
  orders: HyperliquidOrderWire[];
  grouping: 'na' | 'normalTpsl' | 'positionTpsl';
}

export interface HyperliquidCancelWire {
  a: number; // asset index
  o: number; // order ID (oid)
}

export interface HyperliquidCancelAction {
  type: 'cancel';
  cancels: HyperliquidCancelWire[];
}

export interface HyperliquidCancelByCloidWire {
  asset: number;
  cloid: string;
}

export interface HyperliquidCancelByCloidAction {
  type: 'cancelByCloid';
  cancels: HyperliquidCancelByCloidWire[];
}

export type HyperliquidL1Action =
  | HyperliquidOrderAction
  | HyperliquidCancelAction
  | HyperliquidCancelByCloidAction;

export interface HyperliquidSignature {
  r: string;
  s: string;
  v: number;
}

export interface HyperliquidExchangePayload {
  action: HyperliquidL1Action;
  nonce: number;
  signature: HyperliquidSignature;
  vaultAddress: string | null;
}

export interface HyperliquidOrderPlacementStatus {
  resting?: { oid: number; cloid?: string };
  filled?: { oid: number; totalSz: string; avgPx: string; cloid?: string };
  error?: string;
}

export interface HyperliquidExchangeResponse {
  status: 'ok' | 'err';
  response: {
    type: 'order' | 'cancel' | 'cancelByCloid' | 'default';
    data?: {
      statuses: (HyperliquidOrderPlacementStatus | string)[];
    };
  };
}

// ==========================================
// 3. NORMALIZED INTERNAL TYPES (HEDGE ENGINE)
// ==========================================

export type HedgeOrderStatus =
  | 'CREATED'
  | 'SUBMITTING'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'UNKNOWN';

export interface HedgeOrderRequest {
  hedgeIntentId: string;
  symbol: string; // e.g. "BTC-USDT" or "BTC-PERP"
  side: 'BUY' | 'SELL';
  quantity: string;
  limitPrice?: string;
  timeInForce?: 'GTC' | 'IOC' | 'ALO';
  reduceOnly?: boolean;
  maxSlippageBps?: number;
}

export interface HedgeOrderResult {
  hedgeIntentId: string;
  cloid: string;
  venueOrderId?: string;
  status: HedgeOrderStatus;
  requestedQuantity: string;
  executedQuantity: string;
  remainingQuantity: string;
  averagePrice?: string;
  fee?: string;
  feeAsset?: string;
  rawVenueResponse?: any;
  error?: string;
  timestamps: {
    submittedAt: Date;
    resolvedAt?: Date;
  };
}

export interface HyperliquidClientConfig {
  hyperliquidEnv: 'testnet' | 'mainnet';
  agentPrivateKey: string;
  accountAddress: string;
  vaultAddress?: string | null;
  requestTimeoutMs?: number;
  rateLimitWeightPerMin?: number;
  redis?: any; // ioredis instance for distributed nonce
}

export enum HyperliquidErrorCode {
  INVALID_CREDENTIALS = 'INVALID_CREDENTIALS',
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  NETWORK_TIMEOUT = 'NETWORK_TIMEOUT',
  INSUFFICIENT_MARGIN = 'INSUFFICIENT_MARGIN',
  INVALID_ORDER_PARAMETERS = 'INVALID_ORDER_PARAMETERS',
  UNKNOWN_ORDER = 'UNKNOWN_ORDER',
  VENUE_HALTED = 'VENUE_HALTED',
  SIGNATURE_VERIFICATION_FAILED = 'SIGNATURE_VERIFICATION_FAILED',
  CIRCUIT_BREAKER_TRIPPED = 'CIRCUIT_BREAKER_TRIPPED',
  REDUCE_ONLY_VIOLATION = 'REDUCE_ONLY_VIOLATION'
}

export class HyperliquidError extends Error {
  constructor(
    public readonly code: HyperliquidErrorCode,
    message: string,
    public readonly details?: any,
    public readonly isRetryable: boolean = false
  ) {
    super(`[Hyperliquid] ${code}: ${message}`);
    this.name = 'HyperliquidError';
  }
}
