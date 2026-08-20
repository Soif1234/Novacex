/**
 * Phase 5.16 — Liquidity WebSocket Bridge
 *
 * Translates normalized provider/aggregator data and execution state events
 * into frontend-safe NovaCEX WebSocket payloads.
 *
 * Architecture:
 *   Hyperliquid / Internal Liquidity
 *         ↓
 *   Provider Adapter / Internal Market Data
 *         ↓
 *   Liquidity Aggregator  (Phase 5.3)
 *         ↓
 *   LiquidityWsBridge  ← THIS FILE
 *         ↓
 *   EventBus (existing Phase 4 infrastructure)
 *         ↓
 *   WebSocketGateway  (existing Phase 4 infrastructure)
 *         ↓
 *   Frontend
 *
 * SECURITY INVARIANT: No provider credentials, API keys, private keys, signing
 * payloads, or raw Hyperliquid structures ever reach this layer.  All outbound
 * payloads are NovaCEX-normalised and credential-free.
 */

import crypto from 'crypto';
import { NormalizedTicker, NormalizedOrderBook } from './adapter';
import { ExecutionStateEvent } from './stateMachine';
import { EventBus } from '../../services/market/event-bus';
import { StateSafetyClassification, IStatefulComponent } from './classification';

// ─── Public liquidity source health ──────────────────────────────────────────

export type SourceHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'STALE';

export interface LiquiditySourceStatus {
  /** NovaCEX-level identifier, e.g. 'INTERNAL' or 'HL_SPOT'. Never a raw secret. */
  sourceId: string;
  health: SourceHealth;
  updatedAt: number;
}

// ─── Normalized outbound event envelopes ─────────────────────────────────────

export interface NovaCEXTickerEvent {
  eventId: string;
  sequence: number;
  symbol: string;
  market: 'SPOT' | 'FUTURES';
  bid: string;
  ask: string;
  lastPrice: string;
  volume24h: string;
  timestamp: number;
  sourceHealth: SourceHealth;
}

export interface NovaCEXOrderBookEvent {
  eventId: string;
  sequence: number;
  symbol: string;
  market: 'SPOT' | 'FUTURES';
  bids: { price: string; quantity: string }[];
  asks: { price: string; quantity: string }[];
  isSnapshot: boolean;
  timestamp: number;
}

export interface NovaCEXExecutionEvent {
  eventId: string;
  sequence: number;
  executionId: string;
  clientOrderId: string;
  market: 'SPOT' | 'FUTURES';
  symbol: string;
  status: string;
  filledQuantity: string;
  remainingQuantity: string;
  averagePrice?: string;
  fee?: string;
  feeAsset?: string;
  timestamp: number;
}

export interface NovaCEXSourceHealthEvent {
  eventId: string;
  sourceId: string;   // Normalized — no provider secrets
  health: SourceHealth;
  timestamp: number;
}

// ─── Sequence / deduplication bookkeeping ────────────────────────────────────

interface SeenEntry {
  seq: number;
  ts: number;
}

const SEEN_TTL_MS = 30_000; // 30 s de-dup window

/**
 * LiquidityWsBridge
 *
 * Translates normalized liquidity domain events into frontend-safe envelopes
 * and publishes them onto the existing EventBus so the WebSocketGateway picks
 * them up automatically.
 *
 * This class is NOT a financial authority.  It only forwards events that the
 * authoritative NovaCEX domain has already committed.
 */
export class LiquidityWsBridge implements IStatefulComponent {
  private readonly bus: EventBus;

  /** Per-channel monotonic sequence counter */
  private sequences = new Map<string, number>();
  /** Per-channel de-dup cache: eventId → SeenEntry */
  private seen = new Map<string, Map<string, SeenEntry>>();

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  getSafetyClassification(): StateSafetyClassification {
    // Sequences and dedup are safe to lose on crash since EventBus is not the authority.
    return StateSafetyClassification.EPHEMERAL_SINGLE_NODE;
  }

  // ─── Ticker ────────────────────────────────────────────────────────────────

  /**
   * Publish a normalized ticker update.
   * @param ticker   NovaCEX-normalized ticker (no provider details)
   * @param market   'SPOT' | 'FUTURES' — kept strictly separate
   * @param health   Current health of the originating aggregated source
   */
  publishTicker(ticker: NormalizedTicker, market: 'SPOT' | 'FUTURES', health: SourceHealth = 'HEALTHY'): void {
    const channel = `ticker:${ticker.symbol.toUpperCase()}`;
    const seq = this.nextSeq(channel);
    const eventId = this.makeEventId('ticker', ticker.symbol, seq);

    if (this.isDuplicate(channel, eventId)) return;

    const envelope: NovaCEXTickerEvent = {
      eventId,
      sequence: seq,
      symbol: ticker.symbol.toUpperCase(),
      market,
      bid: ticker.bid,
      ask: ticker.ask,
      lastPrice: ticker.lastPrice,
      volume24h: ticker.volume24h,
      timestamp: ticker.timestamp.getTime(),
      sourceHealth: health,
    };

    this.bus.publish({
      id: eventId,
      type: 'liquidity.ticker',
      channel,
      symbol: ticker.symbol.toUpperCase(),
      sequence: seq,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: envelope,
    });
  }

  // ─── Order book ────────────────────────────────────────────────────────────

  /**
   * Publish a normalized order-book snapshot or incremental update.
   */
  publishOrderBook(book: NormalizedOrderBook, market: 'SPOT' | 'FUTURES', isSnapshot = false): void {
    const channel = `orderbook:${book.symbol.toUpperCase()}`;
    const seq = this.nextSeq(channel);
    const eventId = this.makeEventId('ob', book.symbol, seq);

    if (this.isDuplicate(channel, eventId)) return;

    const envelope: NovaCEXOrderBookEvent = {
      eventId,
      sequence: seq,
      symbol: book.symbol.toUpperCase(),
      market,
      bids: book.bids,
      asks: book.asks,
      isSnapshot,
      timestamp: book.timestamp.getTime(),
    };

    this.bus.publish({
      id: eventId,
      type: isSnapshot ? 'liquidity.orderbook.snapshot' : 'liquidity.orderbook.update',
      channel,
      symbol: book.symbol.toUpperCase(),
      sequence: seq,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: envelope,
    });
  }

  // ─── Execution state events ─────────────────────────────────────────────────

  /**
   * Publish a normalized execution state event to the private user channel.
   *
   * CRITICAL RULES:
   *  - UNKNOWN is published as UNKNOWN — never silently converted to FILLED.
   *  - FILLED/CONFIRMED only come from the authoritative NovaCEX domain, never
   *    merely because a provider reported a fill.
   *  - executionId is a NovaCEX ID, never a raw Hyperliquid cloid.
   */
  publishExecutionEvent(
    event: ExecutionStateEvent,
    userId: string,
    market: 'SPOT' | 'FUTURES',
    symbol: string,
    clientOrderId: string,
    filledQty: string,
    remainingQty: string,
    averagePrice?: string,
    fee?: string,
    feeAsset?: string,
  ): void {
    const channel = `execution:${event.executionId}`;
    const privateChannel = 'user:orders';
    const seq = event.sequence;
    const eventId = this.makeEventId('exec', event.executionId, seq);

    // De-duplicate replayed or stale events
    if (this.isDuplicate(channel, eventId)) return;

    const envelope: NovaCEXExecutionEvent = {
      eventId,
      sequence: seq,
      executionId: event.executionId,
      clientOrderId,
      market,
      symbol: symbol.toUpperCase(),
      // UNKNOWN is ALWAYS preserved — never silently promoted
      status: event.newState,
      filledQuantity: filledQty,
      remainingQuantity: remainingQty,
      averagePrice,
      fee,
      feeAsset,
      timestamp: event.timestamp,
    };

    this.bus.publish({
      id: eventId,
      type: `liquidity.execution.${event.newState.toLowerCase()}`,
      channel: privateChannel,
      userId,
      sequence: seq,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: envelope,
    });
  }

  // ─── Source health ──────────────────────────────────────────────────────────

  /**
   * Publish a normalized liquidity-source health update.
   * sourceId is a NovaCEX-level label (e.g. 'HL_SPOT') — never an API key.
   */
  publishSourceHealth(sourceId: string, health: SourceHealth): void {
    const channel = `ticker:health`;
    const seq = this.nextSeq(channel);
    const eventId = this.makeEventId('health', sourceId, seq);

    const envelope: NovaCEXSourceHealthEvent = {
      eventId,
      sourceId, // normalised — no secrets
      health,
      timestamp: Date.now(),
    };

    this.bus.publish({
      id: eventId,
      type: 'liquidity.source.health',
      channel,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: envelope,
    });
  }

  // ─── Sequence helpers ───────────────────────────────────────────────────────

  private nextSeq(channel: string): number {
    const next = (this.sequences.get(channel) ?? 0) + 1;
    this.sequences.set(channel, next);
    return next;
  }

  private makeEventId(prefix: string, key: string, seq: number): string {
    return `${prefix}-${key}-${seq}-${crypto.randomUUID().slice(0, 8)}`;
  }

  // ─── De-duplication ─────────────────────────────────────────────────────────

  /**
   * Returns true if the eventId has already been published on this channel
   * within the SEEN_TTL_MS window.  Also prunes expired entries.
   */
  isDuplicate(channel: string, eventId: string): boolean {
    if (!this.seen.has(channel)) this.seen.set(channel, new Map());
    const cache = this.seen.get(channel)!;

    const now = Date.now();
    // Prune stale entries
    for (const [k, v] of cache.entries()) {
      if (now - v.ts > SEEN_TTL_MS) cache.delete(k);
    }

    if (cache.has(eventId)) return true;
    cache.set(eventId, { seq: 0, ts: now });
    return false;
  }

  /**
   * Validate that a stale or out-of-order event should be rejected.
   * Returns true when the incoming sequence is OLDER than what we have seen.
   */
  isStale(channel: string, incomingSeq: number): boolean {
    const current = this.sequences.get(channel) ?? 0;
    return incomingSeq > 0 && incomingSeq < current;
  }
}
