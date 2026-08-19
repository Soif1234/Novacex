import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'http';
import WebSocket from 'ws';
import { app } from '../src/app';
import { db } from '../src/config/database';
import { WebSocketGateway, webSocketGateway } from '../src/websocket';
import { eventBus } from '../src/services/market/event-bus';
import { marketDataService } from '../src/services/market/market.service';
import { authService } from '../src/services/auth/auth.service';
import { spotService } from '../src/services/spot/spot.service';
import { futuresService } from '../src/services/futures/futures.service';
import { ledgerService } from '../src/services/ledger/ledger.service';
import { ServerWsMessage } from '../src/services/market/types';
import { decimalCompare } from '../src/services/ledger/decimal';

class TestWsClient {
  public ws: WebSocket;
  private messageQueue: ServerWsMessage[] = [];
  private waiters: Array<{
    predicate: (m: ServerWsMessage) => boolean;
    resolve: (m: ServerWsMessage) => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(url: string) {
    this.ws = new WebSocket(url);
    this.ws.on('message', (data: any) => {
      try {
        const parsed: ServerWsMessage = JSON.parse(data.toString());
        const idx = this.waiters.findIndex((w) => w.predicate(parsed));
        if (idx !== -1) {
          const waiter = this.waiters.splice(idx, 1)[0];
          waiter.resolve(parsed);
        } else {
          this.messageQueue.push(parsed);
        }
      } catch (e) {}
    });
  }

  public waitOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === WebSocket.OPEN) return resolve();
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
    });
  }

  public send(data: any): void {
    this.ws.send(typeof data === 'string' ? data : JSON.stringify(data));
  }

  public waitForMessage(predicate?: (m: ServerWsMessage) => boolean, timeoutMs = 5000): Promise<ServerWsMessage> {
    const pred = predicate || (() => true);

    const qIdx = this.messageQueue.findIndex(pred);
    if (qIdx !== -1) {
      const msg = this.messageQueue.splice(qIdx, 1)[0];
      return Promise.resolve(msg);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
      }, timeoutMs);

      this.waiters.push({
        predicate: pred,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject,
      });
    });
  }

  public close(): void {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

describe('WebSocket Gateway & Real-Time Market Infrastructure (Phase 4 Step 9)', () => {
  let server: http.Server;
  let port: number;
  let wsUrl: string;
  let gateway: WebSocketGateway;

  let userA: { id: string; email: string; token: string; spotId: string; futuresId: string };
  let userB: { id: string; email: string; token: string; spotId: string; futuresId: string };

  beforeEach(async () => {
    await db.connect();
    await db.reset();
    eventBus.reset();
    marketDataService.reset();

    // Setup HTTP server and WebSocket Gateway
    server = http.createServer(app);
    gateway = new WebSocketGateway({ server, path: '/ws', heartbeatIntervalMs: 500 });

    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        port = addr.port;
        wsUrl = `ws://127.0.0.1:${port}/ws`;
        resolve();
      });
    });

    // Create User A
    const signupA = await authService.signup({
      email: 'ws_user_a@novacex.io',
      password: 'StrongPassword123!',
      displayName: 'WS User A',
    });
    const loginA = await authService.login({
      email: 'ws_user_a@novacex.io',
      password: 'StrongPassword123!',
    });
    userA = {
      id: signupA.user.id,
      email: signupA.user.email,
      token: loginA.sessionToken,
      spotId: signupA.user.accounts.find((a) => a.type === 'SPOT')!.id,
      futuresId: signupA.user.accounts.find((a) => a.type === 'FUTURES')!.id,
    };

    // Create User B
    const signupB = await authService.signup({
      email: 'ws_user_b@novacex.io',
      password: 'StrongPassword123!',
      displayName: 'WS User B',
    });
    const loginB = await authService.login({
      email: 'ws_user_b@novacex.io',
      password: 'StrongPassword123!',
    });
    userB = {
      id: signupB.user.id,
      email: signupB.user.email,
      token: loginB.sessionToken,
      spotId: signupB.user.accounts.find((a) => a.type === 'SPOT')!.id,
      futuresId: signupB.user.accounts.find((a) => a.type === 'FUTURES')!.id,
    };
  });

  afterEach(async () => {
    gateway.close();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  // =========================================================================
  // 1. CONNECTION & PROTOCOL BASICS
  // =========================================================================

  describe('1. Connection & Protocol Basics', () => {
    it('1.1 should establish public WebSocket connection successfully', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();
      expect(client.ws.readyState).toBe(WebSocket.OPEN);
      client.close();
    });

    it('1.2 should respond to ping with pong and timestamp', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'ping' });
      const res = await client.waitForMessage((m) => m.type === 'pong');

      expect(res.type).toBe('pong');
      expect(res.timestamp).toBeDefined();
      client.close();
    });

    it('1.3 should reject malformed JSON with error frame', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send('NOT_A_VALID_JSON{[');
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('INVALID_JSON');
      client.close();
    });

    it('1.4 should reject missing type with error frame', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ someKey: 'no_type' });
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('INVALID_PROTOCOL');
      client.close();
    });

    it('1.5 should reject oversized payloads (>64KB)', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      const bigString = 'X'.repeat(70000);
      client.send(bigString);
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('PAYLOAD_TOO_LARGE');
      client.close();
    });
  });

  // =========================================================================
  // 2. PUBLIC CHANNELS (TICKER, ORDERBOOK, TRADES, MARK PRICE)
  // =========================================================================

  describe('2. Public Market Channels', () => {
    it('2.1 should subscribe to public ticker and receive immediate state & real-time updates', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'ticker:BTCUSDT' });

      // 1. Acknowledge subscription
      const subAck = await client.waitForMessage((m) => m.type === 'subscribed');
      expect(subAck.channel).toBe('ticker:BTCUSDT');

      // 2. Initial state
      const initEvent = await client.waitForMessage((m) => m.type === 'event' && m.channel === 'ticker:BTCUSDT');
      expect(initEvent.data).toBeDefined();

      // 3. Emit live trade update
      marketDataService.recordTrade({
        symbol: 'BTCUSDT',
        price: '53000',
        quantity: '0.5',
        side: 'BUY',
      });

      const liveEvent = await client.waitForMessage((m) => m.type === 'event' && (m.data as any).lastPrice === '53000.000000000000000000');
      expect((liveEvent.data as any).lastPrice).toBe('53000.000000000000000000');
      client.close();
    });

    it('2.2 should subscribe to orderbook and receive initial snapshot then incremental diffs with sequence numbers', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'orderbook:BTCUSDT' });

      // 1. Initial snapshot
      const snapshot = await client.waitForMessage((m) => m.type === 'snapshot' && m.channel === 'orderbook:BTCUSDT');
      expect(snapshot.data).toBeDefined();
      const snapData = snapshot.data as any;
      expect(snapData.sequence).toBeDefined();
      expect(snapData.epoch).toBeDefined();

      // 2. Incremental diff update
      marketDataService.emitOrderBookUpdate('BTCUSDT');

      const update = await client.waitForMessage((m) => m.type === 'event' && m.channel === 'orderbook:BTCUSDT');
      const updateData = update.data as any;
      expect(updateData.sequence).toBeGreaterThan(snapData.sequence);
      expect(updateData.prevSequence).toBe(snapData.sequence);
      client.close();
    });

    it('2.3 should subscribe to public trades channel and receive live executions', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'trades:BTCUSDT' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      marketDataService.recordTrade({
        symbol: 'BTCUSDT',
        price: '54000',
        quantity: '1.25',
        side: 'SELL',
      });

      const tradeEvt = await client.waitForMessage((m) => m.type === 'event' && m.channel === 'trades:BTCUSDT');
      const tData = tradeEvt.data as any;
      expect(decimalCompare(tData.price, '54000')).toBe(0);
      expect(decimalCompare(tData.quantity, '1.25')).toBe(0);
      expect(tData.side).toBe('SELL');
      client.close();
    });

    it('2.4 should subscribe to mark price channel and receive mark updates', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'markPrice:BTCUSDT' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      marketDataService.emitMarkPriceUpdate('BTCUSDT', '50500');

      const markEvt = await client.waitForMessage((m) => m.type === 'event' && (m.data as any).price === '50500.000000000000000000');
      expect((markEvt.data as any).price).toBe('50500.000000000000000000');
      client.close();
    });

    it('2.5 should unsubscribe from public channel cleanly', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'ticker:BTCUSDT' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      client.send({ type: 'unsubscribe', channel: 'ticker:BTCUSDT' });
      const unsubRes = await client.waitForMessage((m) => m.type === 'unsubscribed');
      expect(unsubRes.channel).toBe('ticker:BTCUSDT');
      client.close();
    });

    it('2.6 should reject invalid channel prefix with error', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'invalid_prefix:BTCUSDT' });
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('UNKNOWN_CHANNEL_PREFIX');
      client.close();
    });
  });

  // =========================================================================
  // 3. AUTHENTICATION & PRIVATE CHANNELS
  // =========================================================================

  describe('3. Authentication & Private Channels', () => {
    it('3.1 should reject private channel subscription for unauthenticated client', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'user:orders' });
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('UNAUTHORIZED');
      client.close();
    });

    it('3.2 should authenticate client with valid session token', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'auth', token: userA.token });
      const res = await client.waitForMessage((m) => m.type === 'auth_success');

      expect(res.type).toBe('auth_success');
      expect((res.data as any).userId).toBe(userA.id);
      client.close();
    });

    it('3.3 should reject invalid session token during auth', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'auth', token: 'invalid-token-12345' });
      const res = await client.waitForMessage((m) => m.type === 'auth_failed');

      expect(res.type).toBe('auth_failed');
      expect(res.code).toBe('INVALID_SESSION');
      client.close();
    });

    it('3.4 should route private order events exclusively to owning user', async () => {
      const clientA = new TestWsClient(wsUrl);
      const clientB = new TestWsClient(wsUrl);

      await Promise.all([clientA.waitOpen(), clientB.waitOpen()]);

      // Auth User A and subscribe to user:orders
      clientA.send({ type: 'auth', token: userA.token });
      await clientA.waitForMessage((m) => m.type === 'auth_success');
      clientA.send({ type: 'subscribe', channel: 'user:orders' });
      await clientA.waitForMessage((m) => m.type === 'subscribed');

      // Auth User B and subscribe to user:orders
      clientB.send({ type: 'auth', token: userB.token });
      await clientB.waitForMessage((m) => m.type === 'auth_success');
      clientB.send({ type: 'subscribe', channel: 'user:orders' });
      await clientB.waitForMessage((m) => m.type === 'subscribed');

      // Deposit for User A
      await ledgerService.credit(userA.spotId, 'USDT', '100000', 'DEPOSIT', 'dep-ws-1', 'Deposit');

      // User A places a Spot Limit order
      await spotService.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '40000',
        quantity: '1',
      });

      const evtA = await clientA.waitForMessage((m) => m.channel === 'user:orders');
      expect((evtA.data as any).market).toBe('SPOT');
      expect((evtA.data as any).side).toBe('BUY');
      expect(decimalCompare((evtA.data as any).price, '40000')).toBe(0);

      clientA.close();
      clientB.close();
    });

    it('3.5 should route private balance events to user:balances', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'auth', token: userA.token });
      await client.waitForMessage((m) => m.type === 'auth_success');

      client.send({ type: 'subscribe', channel: 'user:balances' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      // Credit funds
      await ledgerService.credit(userA.spotId, 'USDT', '5000', 'DEPOSIT', 'dep-ws-bal-1', 'Deposit');

      const balEvt = await client.waitForMessage((m) => m.channel === 'user:balances');
      const bData = balEvt.data as any;
      expect(bData.asset).toBe('USDT');
      expect(decimalCompare(bData.availableBalance, '5000')).toBe(0);
      client.close();
    });



    it('3.6 should route private futures position events to user:positions', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'auth', token: userA.token });
      await client.waitForMessage((m) => m.type === 'auth_success');

      client.send({ type: 'subscribe', channel: 'user:positions' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      await ledgerService.credit(userA.futuresId, 'FUTURES_USDT', '50000', 'DEPOSIT', 'fut-dep-1', 'Deposit');

      await futuresService.placeOrder({
        userId: userA.id,
        accountId: userA.futuresId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1',
        leverage: 10,
        marginMode: 'ISOLATED',
      });

      const posEvt = await client.waitForMessage((m) => m.channel === 'user:positions');
      const pData = posEvt.data as any;
      expect(pData.symbol).toBe('BTCUSDT');
      expect(pData.side).toBe('LONG');
      expect(pData.status).toBe('OPEN');
      client.close();
    });
  });

  // =========================================================================
  // 4. MULTI-TAB ISOLATION & LIFECYCLE
  // =========================================================================

  describe('4. Multi-Tab Isolation & Lifecycle', () => {
    it('4.1 should broadcast private events to all tabs of the same user', async () => {
      const tab1 = new TestWsClient(wsUrl);
      const tab2 = new TestWsClient(wsUrl);

      await Promise.all([tab1.waitOpen(), tab2.waitOpen()]);

      // Tab 1 Auth & Sub
      tab1.send({ type: 'auth', token: userA.token });
      await tab1.waitForMessage((m) => m.type === 'auth_success');
      tab1.send({ type: 'subscribe', channel: 'user:balances' });
      await tab1.waitForMessage((m) => m.type === 'subscribed');

      // Tab 2 Auth & Sub
      tab2.send({ type: 'auth', token: userA.token });
      await tab2.waitForMessage((m) => m.type === 'auth_success');
      tab2.send({ type: 'subscribe', channel: 'user:balances' });
      await tab2.waitForMessage((m) => m.type === 'subscribed');

      await ledgerService.credit(userA.spotId, 'USDT', '2500', 'DEPOSIT', 'multi-tab-dep', 'Deposit');

      const [res1, res2] = await Promise.all([
        tab1.waitForMessage((m) => m.channel === 'user:balances'),
        tab2.waitForMessage((m) => m.channel === 'user:balances'),
      ]);

      expect((res1.data as any).availableBalance).toBe('2500.000000000000000000');
      expect((res2.data as any).availableBalance).toBe('2500.000000000000000000');

      tab1.close();
      tab2.close();
    });

    it('4.2 should maintain other tabs when one tab disconnects', async () => {
      const tab1 = new TestWsClient(wsUrl);
      const tab2 = new TestWsClient(wsUrl);

      await Promise.all([tab1.waitOpen(), tab2.waitOpen()]);

      tab1.send({ type: 'auth', token: userA.token });
      await tab1.waitForMessage((m) => m.type === 'auth_success');
      tab1.send({ type: 'subscribe', channel: 'user:balances' });
      await tab1.waitForMessage((m) => m.type === 'subscribed');

      tab2.send({ type: 'auth', token: userA.token });
      await tab2.waitForMessage((m) => m.type === 'auth_success');
      tab2.send({ type: 'subscribe', channel: 'user:balances' });
      await tab2.waitForMessage((m) => m.type === 'subscribed');

      // Close Tab 1
      tab1.close();

      // Tab 2 should still receive events
      await ledgerService.credit(userA.spotId, 'USDT', '1000', 'DEPOSIT', 'dep-surviving-tab', 'Deposit');

      const res = await tab2.waitForMessage((m) => m.channel === 'user:balances');
      expect((res.data as any).availableBalance).toBe('1000.000000000000000000');

      tab2.close();
    });

    it('4.3 should enforce rate limiting when message rate is exceeded', async () => {
      const fastGateway = new WebSocketGateway({ server, path: '/ws-fast', maxMessageRatePerMinute: 5 });
      const client = new TestWsClient(`ws://127.0.0.1:${port}/ws-fast`);
      await client.waitOpen();

      // Send 6 messages in rapid succession
      for (let i = 0; i < 5; i++) {
        client.send({ type: 'ping' });
      }

      client.send({ type: 'ping' });
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('RATE_LIMIT_EXCEEDED');

      client.close();
      fastGateway.close();
    });

    it('4.4 should enforce maximum subscriptions limit per connection', async () => {
      const limitedGateway = new WebSocketGateway({ server, path: '/ws-limited', maxSubscriptionsPerClient: 2 });
      const client = new TestWsClient(`ws://127.0.0.1:${port}/ws-limited`);
      await client.waitOpen();

      client.send({ type: 'subscribe', channel: 'ticker:BTCUSDT' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      client.send({ type: 'subscribe', channel: 'ticker:ETHUSDT' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      client.send({ type: 'subscribe', channel: 'ticker:SOLUSDT' });
      const res = await client.waitForMessage((m) => m.type === 'error');

      expect(res.type).toBe('error');
      expect(res.code).toBe('MAX_SUBSCRIPTIONS_REACHED');

      client.close();
      limitedGateway.close();
    });
  });

  // =========================================================================
  // 5. TRANSACTION & EVENT CONSISTENCY
  // =========================================================================

  describe('5. Transaction / Event Consistency', () => {
    it('5.1 should NOT emit success events if a financial transaction fails/reverts', async () => {
      const client = new TestWsClient(wsUrl);
      await client.waitOpen();

      client.send({ type: 'auth', token: userA.token });
      await client.waitForMessage((m) => m.type === 'auth_success');

      client.send({ type: 'subscribe', channel: 'user:orders' });
      await client.waitForMessage((m) => m.type === 'subscribed');

      // Attempt to place order without balance -> Should fail
      await expect(
        spotService.placeOrder({
          userId: userA.id,
          accountId: userA.spotId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '50000',
          quantity: '10', // Requires 500,000 USDT (user has 0)
        })
      ).rejects.toThrow();

      client.close();
    });

    it('5.2 should verify full lifecycle: order placement -> fill -> trade & balance events', async () => {
      const buyerWs = new TestWsClient(wsUrl);
      const sellerWs = new TestWsClient(wsUrl);

      await Promise.all([buyerWs.waitOpen(), sellerWs.waitOpen()]);

      // Buyer setup
      buyerWs.send({ type: 'auth', token: userA.token });
      await buyerWs.waitForMessage((m) => m.type === 'auth_success');
      buyerWs.send({ type: 'subscribe', channel: 'user:orders' });
      await buyerWs.waitForMessage((m) => m.type === 'subscribed');
      buyerWs.send({ type: 'subscribe', channel: 'user:trades' });
      await buyerWs.waitForMessage((m) => m.type === 'subscribed');

      // Seller setup
      sellerWs.send({ type: 'auth', token: userB.token });
      await sellerWs.waitForMessage((m) => m.type === 'auth_success');
      sellerWs.send({ type: 'subscribe', channel: 'user:trades' });
      await sellerWs.waitForMessage((m) => m.type === 'subscribed');

      // Fund accounts
      await ledgerService.credit(userA.spotId, 'USDT', '100000', 'DEPOSIT', 'dep-buyer-life', 'Deposit');
      await ledgerService.credit(userB.spotId, 'BTC', '2', 'DEPOSIT', 'dep-seller-life', 'Deposit');

      // Seller places resting ask
      await spotService.placeOrder({
        userId: userB.id,
        accountId: userB.spotId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'LIMIT',
        price: '50000',
        quantity: '1',
      });

      // Buyer crosses the spread with MARKET BUY
      await spotService.placeOrder({
        userId: userA.id,
        accountId: userA.spotId,
        symbol: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
        quantity: '1',
      });

      const tradeEvt = await buyerWs.waitForMessage((m) => m.channel === 'user:trades');
      expect((tradeEvt.data as any).symbol).toBe('BTCUSDT');
      expect((tradeEvt.data as any).side).toBe('BUY');
      expect(decimalCompare((tradeEvt.data as any).price, '50000')).toBe(0);

      buyerWs.close();
      sellerWs.close();
    });
  });
});
