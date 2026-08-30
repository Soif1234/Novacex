/**
 * Hyperliquid WebSocket Client & Real-Time Stream Gateway
 * Phase 10.5 â€” Step 10.5-3
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  HyperliquidStreamEvent,
  L2BookSnapshotEvent,
  L2BookUpdateEvent,
  ExternalTradeEvent,
  ExternalFillEvent,
  ExternalOrderUpdateEvent,
  StreamHealthEvent,
  StreamHealthStatus,
  NormalizedL2Level
} from './hyperliquid.events';
import { HedgeOrderStatus } from './hyperliquid.types';
import { decimalCompare, decimalSubtract } from '../../ledger/decimal';
import { HyperliquidAdapter } from './hyperliquid.adapter';

export interface HyperliquidWebSocketConfig {
  hyperliquidEnv: 'testnet' | 'mainnet';
  wsUrlOverride?: string; // Strictly for vitest
  accountAddress?: string;
  staleThresholdMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  maxReconnectDelayMs?: number;
  initialReconnectDelayMs?: number;
  adapter?: any;
}

export class HyperliquidWebSocketClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private isExplicitlyClosed: boolean = false;
  private reconnectAttempts: number = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private heartbeatTimeoutTimer: NodeJS.Timeout | null = null;
  private staleCheckTimer: NodeJS.Timeout | null = null;

  private lastMessageTimestamp: number = 0;
  private healthStatus: StreamHealthStatus = 'DISCONNECTED';

  // Subscriptions registry (for automatic resubscription on reconnect)
  private readonly activeSubscriptions: Map<string, any> = new Map();

  // Deduplication cache for fills (24h retention)
  private readonly seenFills: Set<string> = new Set();
  private readonly maxSeenFills: number = 10000;

  // Local L2 Book Cache
  private readonly localBooks: Map<string, { bids: NormalizedL2Level[]; asks: NormalizedL2Level[]; timestamp: number }> = new Map();

  // Configuration
  private readonly wsUrl: string;
  private readonly accountAddress?: string;
  private readonly staleThresholdMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly initialReconnectDelayMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly adapter?: HyperliquidAdapter;

  constructor(config: HyperliquidWebSocketConfig) {
    super();
    this.wsUrl = config.wsUrlOverride && process.env.NODE_ENV === 'test'
        ? config.wsUrlOverride
        : config.hyperliquidEnv === 'mainnet' ? 'wss://api.hyperliquid.xyz/ws' : 'wss://api.hyperliquid-testnet.xyz/ws';
    this.accountAddress = config.accountAddress?.toLowerCase();
    this.staleThresholdMs = config.staleThresholdMs || 10000; // 10s default
    this.heartbeatIntervalMs = config.heartbeatIntervalMs || 15000; // 15s default
    this.heartbeatTimeoutMs = config.heartbeatTimeoutMs || 5000; // 5s default
    this.initialReconnectDelayMs = config.initialReconnectDelayMs || 1000;
    this.maxReconnectDelayMs = config.maxReconnectDelayMs || 30000;
    this.adapter = config.adapter;
  }

  // ==========================================
  // 1. LIFECYCLE & CONNECTION MANAGEMENT
  // ==========================================

  public connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isExplicitlyClosed = false;
    this.clearTimers();

    try {
      this.ws = new WebSocket(this.wsUrl);
      this.setupSocketHandlers();
    } catch (err: any) {
      this.handleConnectionFailure(err.message || 'Connection instantiation failed');
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.updateHealth('DISCONNECTED', 'Client disconnected explicitly');
  }

  public getHealthStatus(): StreamHealthStatus {
    return this.healthStatus;
  }

  public getLastMessageTimestamp(): number {
    return this.lastMessageTimestamp;
  }

  public getReconnectCount(): number {
    return this.reconnectAttempts;
  }

  public getLocalBook(coin: string): { bids: NormalizedL2Level[]; asks: NormalizedL2Level[]; timestamp: number } | undefined {
    return this.localBooks.get(coin.toUpperCase());
  }

  // ==========================================
  // 2. SUBSCRIPTION API
  // ==========================================

  public subscribeL2Book(coin: string): void {
    const sub = { type: 'l2Book', coin: coin.toUpperCase() };
    const key = `l2Book:${coin.toUpperCase()}`;
    this.activeSubscriptions.set(key, sub);
    this.sendSubscription(sub);
  }

  public unsubscribeL2Book(coin: string): void {
    const sub = { type: 'l2Book', coin: coin.toUpperCase() };
    const key = `l2Book:${coin.toUpperCase()}`;
    this.activeSubscriptions.delete(key);
    this.localBooks.delete(coin.toUpperCase());
    this.sendUnsubscription(sub);
  }

  public subscribeTrades(coin: string): void {
    const sub = { type: 'trades', coin: coin.toUpperCase() };
    const key = `trades:${coin.toUpperCase()}`;
    this.activeSubscriptions.set(key, sub);
    this.sendSubscription(sub);
  }

  public subscribeUserFills(userAddress?: string): void {
    const user = (userAddress || this.accountAddress)?.toLowerCase();
    if (!user) {
      throw new Error('userAddress is required to subscribe to userFills');
    }
    const sub = { type: 'userFills', user };
    const key = `userFills:${user}`;
    this.activeSubscriptions.set(key, sub);
    this.sendSubscription(sub);
  }

  public subscribeOrderUpdates(userAddress?: string): void {
    const user = (userAddress || this.accountAddress)?.toLowerCase();
    if (!user) {
      throw new Error('userAddress is required to subscribe to orderUpdates');
    }
    const sub = { type: 'orderUpdates', user };
    const key = `orderUpdates:${user}`;
    this.activeSubscriptions.set(key, sub);
    this.sendSubscription(sub);
  }

  // ==========================================
  // 3. INTERNAL SOCKET HANDLERS
  // ==========================================

  private setupSocketHandlers(): void {
    if (!this.ws) return;

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      this.lastMessageTimestamp = Date.now();
      this.updateHealth('HEALTHY', 'Connected to Hyperliquid WebSocket');
      this.resubscribeAll();
      this.startHeartbeat();
      this.startStaleMonitor();

      // Trigger asynchronous REST recovery on reconnect if adapter exists
      if (this.adapter) {
        this.performRestRecovery().catch(err => {
          this.emit('error', new Error(`REST recovery failed on reconnect: ${err.message}`));
        });
      }
    });

    this.ws.on('message', (raw: any) => {
      this.lastMessageTimestamp = Date.now();
      if (this.healthStatus === 'STALE' || this.healthStatus === 'DEGRADED') {
        this.updateHealth('HEALTHY');
      }
      this.handleIncomingMessage(raw.toString());
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });

    this.ws.on('close', () => {
      if (!this.isExplicitlyClosed) {
        this.handleConnectionFailure('Socket closed by remote or network error');
      }
    });
  }

  private handleIncomingMessage(rawString: string): void {
    let msg: any;
    try {
      msg = JSON.parse(rawString);
    } catch {
      // Malformed JSON is discarded safely
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    // Heartbeat pong response
    if (msg.channel === 'pong') {
      if (this.heartbeatTimeoutTimer) {
        clearTimeout(this.heartbeatTimeoutTimer);
        this.heartbeatTimeoutTimer = null;
      }
      return;
    }

    const channel = msg.channel;
    const data = msg.data;

    if (!channel || !data) return;

    switch (channel) {
      case 'l2Book':
        this.handleL2BookMessage(data);
        break;
      case 'trades':
        this.handleTradesMessage(data);
        break;
      case 'userFills':
        this.handleUserFillsMessage(data);
        break;
      case 'orderUpdates':
        this.handleOrderUpdatesMessage(data);
        break;
      default:
        break;
    }
  }

  // ==========================================
  // 4. STREAM PARSERS & EVENT DISPATCHERS
  // ==========================================

  private handleL2BookMessage(data: any): void {
    if (!data.coin || !Array.isArray(data.levels) || data.levels.length < 2) return;

    const coin = String(data.coin).toUpperCase();
    const time = Number(data.time) || Date.now();

    const bids: NormalizedL2Level[] = [];
    for (const b of data.levels[0] || []) {
      if (this.isValidLevel(b)) {
        bids.push({ price: String(b.px), size: String(b.sz), orderCount: Number(b.n) || 1 });
      }
    }

    const asks: NormalizedL2Level[] = [];
    for (const a of data.levels[1] || []) {
      if (this.isValidLevel(a)) {
        asks.push({ price: String(a.px), size: String(a.sz), orderCount: Number(a.n) || 1 });
      }
    }

    // Update local cache
    this.localBooks.set(coin, { bids, asks, timestamp: time });

    const event: L2BookSnapshotEvent = {
      type: 'L2_BOOK_SNAPSHOT',
      market: coin,
      bids,
      asks,
      timestamp: time
    };

    this.emit('l2Book', event);
    this.emit('event', event);
  }

  private handleTradesMessage(data: any): void {
    if (!Array.isArray(data)) return;

    for (const t of data) {
      if (!t.coin || !t.px || !t.sz) continue;
      const price = String(t.px);
      const size = String(t.sz);
      if (decimalCompare(price, '0') <= 0 || decimalCompare(size, '0') <= 0) continue;

      const event: ExternalTradeEvent = {
        type: 'TRADE',
        market: String(t.coin).toUpperCase(),
        price,
        size,
        side: t.side === 'B' ? 'BUY' : 'SELL',
        tid: String(t.tid || t.time || Date.now()),
        timestamp: Number(t.time) || Date.now()
      };

      this.emit('trade', event);
      this.emit('event', event);
    }
  }

  private handleUserFillsMessage(data: any): void {
    if (!data || !Array.isArray(data.fills)) return;

    const user = String(data.user || this.accountAddress || '').toLowerCase();
    const isSnapshot = !!data.isSnapshot;

    for (const fill of data.fills) {
      if (!fill.coin || !fill.px || !fill.sz) continue;

      const fillId = fill.tid ? String(fill.tid) : `${fill.hash || 'fill'}-${fill.oid}-${fill.time}`;

      // Idempotency: skip already seen fills
      if (this.seenFills.has(fillId)) {
        continue;
      }
      this.recordSeenFill(fillId);

      const event: ExternalFillEvent = {
        type: 'USER_FILL',
        venue: 'HYPERLIQUID',
        account: user,
        externalOrderId: String(fill.oid || ''),
        clientOrderId: fill.cloid ? String(fill.cloid) : undefined,
        market: String(fill.coin).toUpperCase(),
        side: fill.side === 'B' ? 'BUY' : 'SELL',
        quantity: String(fill.sz),
        price: String(fill.px),
        fee: String(fill.fee || '0'),
        feeAsset: String(fill.feeToken || 'USDC'),
        fillId,
        closedPnl: String(fill.closedPnl || '0'),
        direction: String(fill.dir || ''),
        isSnapshot,
        timestamp: Number(fill.time) || Date.now()
      };

      this.emit('userFill', event);
      this.emit('event', event);
    }
  }

  private handleOrderUpdatesMessage(data: any): void {
    if (!Array.isArray(data)) return;

    for (const update of data) {
      if (!update.order || !update.order.coin) continue;
      const ord = update.order;

      let status: HedgeOrderStatus = 'UNKNOWN';
      const statStr = String(update.status || '').toLowerCase();
      if (statStr === 'open') status = 'OPEN';
      else if (statStr === 'filled') status = 'FILLED';
      else if (statStr === 'canceled') status = 'CANCELED';
      else if (statStr === 'rejected') status = 'REJECTED';

      const originalSize = String(ord.origSz || ord.sz || '0');
      const remainingSize = String(ord.sz || '0');
      const executedSize = decimalSubtract(originalSize, remainingSize);

      const event: ExternalOrderUpdateEvent = {
        type: 'USER_ORDER_UPDATE',
        venue: 'HYPERLIQUID',
        account: String(this.accountAddress || ''),
        externalOrderId: String(ord.oid || ''),
        clientOrderId: ord.cloid ? String(ord.cloid) : undefined,
        market: String(ord.coin).toUpperCase(),
        side: ord.side === 'B' ? 'BUY' : 'SELL',
        status,
        limitPrice: String(ord.limitPx || '0'),
        originalSize,
        remainingSize,
        executedSize,
        timestamp: Number(update.statusTimestamp || ord.timestamp || Date.now())
      };

      this.emit('orderUpdate', event);
      this.emit('event', event);
    }
  }

  // ==========================================
  // 5. REST RECOVERY ON RECONNECT
  // ==========================================

  public async performRestRecovery(): Promise<void> {
    if (!this.adapter) return;

    try {
      const fills = await this.adapter.getClient().getUserFills();
      for (const fill of fills) {
        const fillId = fill.tid ? String(fill.tid) : `${fill.hash || 'rest'}-${fill.oid}-${fill.time}`;
        if (this.seenFills.has(fillId)) continue;
        this.recordSeenFill(fillId);

        const event: ExternalFillEvent = {
          type: 'USER_FILL',
          venue: 'HYPERLIQUID',
          account: String(this.accountAddress || ''),
          externalOrderId: String(fill.oid),
          clientOrderId: fill.cloid,
          market: fill.coin.toUpperCase(),
          side: fill.side === 'B' ? 'BUY' : 'SELL',
          quantity: fill.sz,
          price: fill.px,
          fee: fill.fee,
          feeAsset: fill.feeToken,
          fillId,
          closedPnl: fill.closedPnl,
          direction: fill.dir,
          isSnapshot: true,
          timestamp: fill.time
        };

        this.emit('userFill', event);
        this.emit('event', event);
      }
    } catch (err: any) {
      this.emit('error', new Error(`REST reconciliation failure: ${err.message}`));
    }
  }

  // ==========================================
  // 6. HEARTBEAT, STALENESS & RECONNECT LOGIC
  // ==========================================

  private startHeartbeat(): void {
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ method: 'ping' }));

          this.heartbeatTimeoutTimer = setTimeout(() => {
            this.handleConnectionFailure('Heartbeat pong timeout');
          }, this.heartbeatTimeoutMs);
        } catch {
          this.handleConnectionFailure('Failed to send heartbeat ping');
        }
      }
    }, this.heartbeatIntervalMs);
  }

  private startStaleMonitor(): void {
    this.staleCheckTimer = setInterval(() => {
      if (this.healthStatus === 'HEALTHY' && this.lastMessageTimestamp > 0) {
        const elapsed = Date.now() - this.lastMessageTimestamp;
        if (elapsed > this.staleThresholdMs) {
          this.updateHealth('STALE', `No message received for ${elapsed}ms (threshold: ${this.staleThresholdMs}ms)`);
        }
      }
    }, 2000);
  }

  private handleConnectionFailure(reason: string): void {
    if (this.isExplicitlyClosed) return;

    this.clearTimers();
    this.updateHealth('DEGRADED', reason);

    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {}
      this.ws = null;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isExplicitlyClosed) return;

    this.reconnectAttempts += 1;
    // Exponential backoff + jitter
    const delay = Math.min(
      this.maxReconnectDelayMs,
      this.initialReconnectDelayMs * Math.pow(1.5, this.reconnectAttempts) + Math.random() * 500
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private resubscribeAll(): void {
    for (const [, sub] of this.activeSubscriptions.entries()) {
      this.sendSubscription(sub);
    }
  }

  private sendSubscription(sub: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ method: 'subscribe', subscription: sub }));
      } catch (err: any) {
        this.emit('error', new Error(`Subscription send failed: ${err.message}`));
      }
    }
  }

  private sendUnsubscription(sub: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ method: 'unsubscribe', subscription: sub }));
      } catch (err: any) {
        this.emit('error', new Error(`Unsubscription send failed: ${err.message}`));
      }
    }
  }

  private updateHealth(status: StreamHealthStatus, reason?: string): void {
    this.healthStatus = status;
    const event: StreamHealthEvent = {
      type: 'STREAM_HEALTH',
      venue: 'HYPERLIQUID',
      status,
      lastMessageTimestamp: this.lastMessageTimestamp,
      reconnectCount: this.reconnectAttempts,
      activeSubscriptionsCount: this.activeSubscriptions.size,
      reason
    };
    this.emit('health', event);
    this.emit('event', event);
  }

  private clearTimers(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    if (this.staleCheckTimer) clearInterval(this.staleCheckTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.heartbeatTimer = null;
    this.heartbeatTimeoutTimer = null;
    this.staleCheckTimer = null;
    this.reconnectTimer = null;
  }

  private isValidLevel(level: any): boolean {
    if (!level || typeof level !== 'object') return false;
    try { return decimalCompare(String(level.px), "0") > 0 && decimalCompare(String(level.sz), "0") >= 0; } catch { return false; }
  }

  private recordSeenFill(fillId: string): void {
    if (this.seenFills.size >= this.maxSeenFills) {
      const first = this.seenFills.values().next().value;
      if (first) this.seenFills.delete(first);
    }
    this.seenFills.add(fillId);
  }
}
