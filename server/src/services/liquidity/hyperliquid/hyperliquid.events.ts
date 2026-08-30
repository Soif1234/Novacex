/**
 * Hyperliquid Normalized WebSocket Event Definitions
 * Phase 10.5 â€” Step 10.5-3
 */

import { HedgeOrderStatus } from './hyperliquid.types';

export type StreamHealthStatus = 'HEALTHY' | 'DEGRADED' | 'DISCONNECTED' | 'STALE';

export interface NormalizedL2Level {
  price: string;
  size: string;
  orderCount: number;
}

export interface L2BookSnapshotEvent {
  type: 'L2_BOOK_SNAPSHOT';
  market: string;
  bids: NormalizedL2Level[];
  asks: NormalizedL2Level[];
  timestamp: number;
}

export interface L2BookUpdateEvent {
  type: 'L2_BOOK_UPDATE';
  market: string;
  bids: NormalizedL2Level[];
  asks: NormalizedL2Level[];
  timestamp: number;
}

export interface ExternalTradeEvent {
  type: 'TRADE';
  market: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL';
  tid: string;
  timestamp: number;
}

export interface ExternalFillEvent {
  type: 'USER_FILL';
  venue: 'HYPERLIQUID';
  account: string;
  externalOrderId: string;
  clientOrderId?: string;
  market: string;
  side: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  fee: string;
  feeAsset: string;
  fillId: string; // Canonical idempotency key (tid or hash-oid)
  closedPnl: string;
  direction: string;
  isSnapshot: boolean;
  timestamp: number;
}

export interface ExternalOrderUpdateEvent {
  type: 'USER_ORDER_UPDATE';
  venue: 'HYPERLIQUID';
  account: string;
  externalOrderId: string;
  clientOrderId?: string;
  market: string;
  side: 'BUY' | 'SELL';
  status: HedgeOrderStatus;
  limitPrice: string;
  originalSize: string;
  remainingSize: string;
  executedSize: string;
  timestamp: number;
}

export interface StreamHealthEvent {
  type: 'STREAM_HEALTH';
  venue: 'HYPERLIQUID';
  status: StreamHealthStatus;
  lastMessageTimestamp: number;
  reconnectCount: number;
  activeSubscriptionsCount: number;
  reason?: string;
}

export interface StreamGapEvent {
  type: 'STREAM_GAP';
  market: string;
  expectedSequence?: number;
  receivedSequence?: number;
  actionTaken: 'REQUEST_SNAPSHOT';
  timestamp: number;
}

export interface UncorrelatedExternalActivityEvent {
  type: 'EXTERNAL_ACTIVITY_UNCORRELATED';
  venue: 'HYPERLIQUID';
  activityType: 'FILL' | 'ORDER' | 'POSITION_CHANGE';
  rawEvent: any;
  reason: string;
  timestamp: number;
}

export type HyperliquidStreamEvent =
  | L2BookSnapshotEvent
  | L2BookUpdateEvent
  | ExternalTradeEvent
  | ExternalFillEvent
  | ExternalOrderUpdateEvent
  | StreamHealthEvent
  | StreamGapEvent
  | UncorrelatedExternalActivityEvent;
