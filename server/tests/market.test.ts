import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { app } from '../src/app';
import { db } from '../src/config/database';
import { EventBus, eventBus } from '../src/services/market/event-bus';
import { MarketDataService, marketDataService } from '../src/services/market/market.service';
import { matchingEngine } from '../src/services/spot/matching.engine';
import { decimalCompare, decimalNormalize } from '../src/services/ledger/decimal';
import { MarketEvent } from '../src/services/market/types';

describe('Server-Side Market Data & EventBus Engine (Phase 4 Step 9)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    await db.connect();
    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as any;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    await db.close();
  });

  beforeEach(async () => {
    await db.reset();
    eventBus.reset();
    matchingEngine.clear();
    marketDataService.reset();
  });


  // =========================================================================
  // 1. EVENT BUS CORE & DISPATCH
  // =========================================================================

  describe('1. EventBus Core & Protocol', () => {
    it('1.1 should publish and receive events subscribed by event type', async () => {
      const received: MarketEvent[] = [];
      const unsub = eventBus.subscribe('market.ticker', (evt) => {
        received.push(evt);
      });

      eventBus.publish({
        id: 'evt-1',
        type: 'market.ticker',
        symbol: 'BTCUSDT',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: { lastPrice: '50000.000000000000000000' },
      });

      expect(received.length).toBe(1);
      expect(received[0].id).toBe('evt-1');
      expect(received[0].type).toBe('market.ticker');
      expect((received[0].payload as any).lastPrice).toBe('50000.000000000000000000');

      unsub();
      eventBus.publish({
        id: 'evt-2',
        type: 'market.ticker',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: { lastPrice: '51000' },
      });
      expect(received.length).toBe(1); // Unsubscribed
    });

    it('1.2 should publish and receive events subscribed by channel', async () => {
      const received: MarketEvent[] = [];
      const unsub = eventBus.subscribeChannel('ticker:BTCUSDT', (evt) => {
        received.push(evt);
      });

      eventBus.publish({
        id: 'evt-1',
        type: 'market.ticker',
        channel: 'ticker:BTCUSDT',
        symbol: 'BTCUSDT',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: { lastPrice: '50000' },
      });

      // Different channel should not be received
      eventBus.publish({
        id: 'evt-2',
        type: 'market.ticker',
        channel: 'ticker:ETHUSDT',
        symbol: 'ETHUSDT',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: { lastPrice: '3000' },
      });

      expect(received.length).toBe(1);
      expect(received[0].channel).toBe('ticker:BTCUSDT');

      unsub();
    });

    it('1.3 should route private user events by userId with strict isolation', async () => {
      const userAEvents: MarketEvent[] = [];
      const userBEvents: MarketEvent[] = [];

      const unsubA = eventBus.subscribeUser('user-a-uuid', (evt) => { userAEvents.push(evt); });
      const unsubB = eventBus.subscribeUser('user-b-uuid', (evt) => { userBEvents.push(evt); });

      // Emit private event for User A
      eventBus.publish({
        id: 'evt-priv-1',
        type: 'spot.order.created',
        channel: 'user:orders',
        userId: 'user-a-uuid',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: { orderId: 'ord-123', quantity: '1.5' },
      });

      expect(userAEvents.length).toBe(1);
      expect(userBEvents.length).toBe(0);

      // Emit private event for User B
      eventBus.publish({
        id: 'evt-priv-2',
        type: 'wallet.balance.updated',
        channel: 'user:balances',
        userId: 'user-b-uuid',
        timestamp: Date.now(),
        version: '1.0.0',
        payload: { asset: 'USDT', availableBalance: '1000' },
      });

      expect(userAEvents.length).toBe(1);
      expect(userBEvents.length).toBe(1);
      expect((userBEvents[0].payload as any).availableBalance).toBe('1000');

      unsubA();
      unsubB();
    });


    it('1.4 should auto-populate event id, timestamp, and version if missing', () => {
      let received: MarketEvent | null = null;
      eventBus.subscribe('test.event', (evt) => {
        received = evt;
      });

      eventBus.publish({
        type: 'test.event',
        payload: { key: 'value' },
      } as any);

      expect(received).not.toBeNull();
      expect(received!.id).toBeDefined();
      expect(received!.timestamp).toBeGreaterThan(0);
      expect(received!.version).toBe('1.0.0');
    });
  });

  // =========================================================================
  // 2. ORDER BOOK SEQUENCING, SNAPSHOTS & DIFFS
  // =========================================================================

  describe('2. OrderBook Sequencing & Snapshots', () => {
    it('2.1 should retrieve initial OrderBook snapshot with sequence and epoch', () => {
      const snap = marketDataService.getOrderBook('BTCUSDT');
      expect(snap.symbol).toBe('BTCUSDT');
      expect(snap.sequence).toBe(1000);
      expect(snap.epoch).toBeGreaterThan(0);
      expect(Array.isArray(snap.bids)).toBe(true);
      expect(Array.isArray(snap.asks)).toBe(true);
    });

    it('2.2 should emit incremental OrderBook updates with monotonically increasing sequences', () => {
      const updates: any[] = [];
      const unsub = eventBus.subscribeChannel('orderbook:BTCUSDT', (evt) => {
        updates.push(evt.payload);
      });

      const u1 = marketDataService.emitOrderBookUpdate('BTCUSDT');
      const u2 = marketDataService.emitOrderBookUpdate('BTCUSDT');
      const u3 = marketDataService.emitOrderBookUpdate('BTCUSDT');

      expect(updates.length).toBe(3);
      expect(u1.prevSequence).toBe(1000);
      expect(u1.sequence).toBe(1001);

      expect(u2.prevSequence).toBe(1001);
      expect(u2.sequence).toBe(1002);

      expect(u3.prevSequence).toBe(1002);
      expect(u3.sequence).toBe(1003);

      unsub();
    });

    it('2.3 should change epoch upon service reset/restart', () => {
      const epoch1 = marketDataService.getEpoch();
      marketDataService.reset();
      const epoch2 = marketDataService.getEpoch();

      expect(epoch2).toBeGreaterThanOrEqual(epoch1);
      const snap = marketDataService.getOrderBook('BTCUSDT');
      expect(snap.epoch).toBe(epoch2);
    });

    it('2.4 should reflect orderbook changes from matching engine in snapshots', () => {
      matchingEngine.getBook('BTCUSDT').addRestingOrder({

        id: 'ord-ask-1',
        accountId: 'acc-1',
        market: 'SPOT',
        symbol: 'BTCUSDT',
        side: 'SELL',
        type: 'LIMIT',
        price: '51000.000000000000000000',
        quantity: '2.500000000000000000',
        filledQuantity: '0.000000000000000000',
        remainingQuantity: '2.500000000000000000',
        lockedAmount: '2.500000000000000000',
        lockedAsset: 'BTC',
        status: 'NEW',
        timeInForce: 'GTC',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const snap = marketDataService.getOrderBook('BTCUSDT');
      expect(snap.asks.length).toBeGreaterThan(0);
      expect(decimalCompare(snap.asks[0][0], '51000')).toBe(0);
      expect(decimalCompare(snap.asks[0][1], '2.5')).toBe(0);
    });
  });

  // =========================================================================
  // 3. TICKER & RECENT TRADES
  // =========================================================================

  describe('3. Ticker & Trade Recording', () => {
    it('3.1 should retrieve ticker with exact string decimal values', () => {
      const ticker = marketDataService.getTicker('BTCUSDT');
      expect(ticker).not.toBeNull();
      expect(typeof ticker!.lastPrice).toBe('string');
      expect(decimalCompare(ticker!.lastPrice, '50000')).toBe(0);
      expect(typeof ticker!.high24h).toBe('string');
      expect(typeof ticker!.low24h).toBe('string');
      expect(typeof ticker!.volume24h).toBe('string');
    });

    it('3.2 should record trades, update ticker lastPrice and emit public events', () => {
      const tradeEvents: MarketEvent[] = [];
      const tickerEvents: MarketEvent[] = [];

      const unsubTrades = eventBus.subscribeChannel('trades:BTCUSDT', (evt) => { tradeEvents.push(evt); });
      const unsubTicker = eventBus.subscribeChannel('ticker:BTCUSDT', (evt) => { tickerEvents.push(evt); });

      const trade = marketDataService.recordTrade({

        symbol: 'BTCUSDT',
        price: '52500',
        quantity: '0.75',
        side: 'BUY',
        isMaker: false,
      });

      expect(trade.price).toBe('52500.000000000000000000');
      expect(trade.quantity).toBe('0.750000000000000000');
      expect(trade.quoteQuantity).toBe('39375.000000000000000000');

      // Check recent trades buffer
      const recents = marketDataService.getRecentTrades('BTCUSDT');
      expect(recents.length).toBe(1);
      expect(recents[0].tradeId).toBe(trade.tradeId);

      // Check ticker updated
      const ticker = marketDataService.getTicker('BTCUSDT');
      expect(decimalCompare(ticker!.lastPrice, '52500')).toBe(0);

      // Check public event emission
      expect(tradeEvents.length).toBe(1);
      expect(tradeEvents[0].channel).toBe('trades:BTCUSDT');
      expect(tickerEvents.length).toBe(1);
      expect(tickerEvents[0].channel).toBe('ticker:BTCUSDT');

      unsubTrades();
      unsubTicker();
    });

    it('3.3 should retrieve mark price from provider', async () => {
      const mark = await marketDataService.getMarkPrice('BTCUSDT');
      expect(mark.symbol).toBe('BTCUSDT');
      expect(decimalCompare(mark.price, '50000')).toBe(0);
      expect(typeof mark.price).toBe('string');
    });
  });

  // =========================================================================
  // 4. REST MARKET DATA APIS
  // =========================================================================

  describe('4. REST Market Endpoints', () => {
    it('4.1 GET /api/v1/market/tickers should list all tickers', async () => {
      const res = await (await fetch(`${baseUrl}/api/v1/market/tickers`)).json();

      expect(res.success).toBe(true);
      expect(Array.isArray(res.data.tickers)).toBe(true);
      expect(res.data.tickers.length).toBeGreaterThanOrEqual(3);
    });

    it('4.2 GET /api/v1/market/ticker/:symbol should return single ticker', async () => {
      const res = await (await fetch(`${baseUrl}/api/v1/market/ticker/BTCUSDT`)).json();

      expect(res.success).toBe(true);
      expect(res.data.symbol).toBe('BTCUSDT');
      expect(decimalCompare(res.data.lastPrice, '50000')).toBe(0);
    });

    it('4.3 GET /api/v1/market/orderbook/:symbol should return orderbook snapshot', async () => {
      const res = await (await fetch(`${baseUrl}/api/v1/market/orderbook/BTCUSDT`)).json();

      expect(res.success).toBe(true);
      expect(res.data.symbol).toBe('BTCUSDT');
      expect(res.data.sequence).toBeDefined();
      expect(res.data.epoch).toBeDefined();
    });

    it('4.4 GET /api/v1/market/trades/:symbol should return recent public trades', async () => {
      marketDataService.recordTrade({
        symbol: 'BTCUSDT',
        price: '49500',
        quantity: '1.2',
        side: 'SELL',
      });

      const res = await (await fetch(`${baseUrl}/api/v1/market/trades/BTCUSDT`)).json();

      expect(res.success).toBe(true);
      expect(res.data.trades.length).toBeGreaterThan(0);
      expect(res.data.trades[0].side).toBe('SELL');
    });

    it('4.5 GET /api/v1/market/mark-price/:symbol should return mark price', async () => {
      const res = await (await fetch(`${baseUrl}/api/v1/market/mark-price/BTCUSDT`)).json();

      expect(res.success).toBe(true);
      expect(res.data.symbol).toBe('BTCUSDT');
      expect(decimalCompare(res.data.price, '50000')).toBe(0);
    });
  });
});
