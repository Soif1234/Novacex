import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabasePool } from '../src/config/database';
import { KLineService } from '../src/services/market/kline.service';
import { eventBus } from '../src/services/market/event-bus';
import { env } from '../src/config/env';

describe('Market Data Infrastructure / OHLCV K-Lines (Phase 6.2)', () => {
  let db: DatabasePool;
  let klineService: KLineService;

  beforeEach(async () => {
    db = new DatabasePool();
    await db.connect();
    klineService = new KLineService(db);
    await klineService.start();
  });

  afterEach(async () => {
    await klineService.stop();
    vi.useRealTimers();
  });

  it('1. First trade creates candles for all intervals', async () => {
    const trade = {
      tradeId: 't1',
      symbol: 'BTCUSDT',
      price: '60000',
      quantity: '1',
      isMaker: false,
      timestamp: 1600000020000,
    };

    eventBus.publish({ type: 'market.trade', payload: trade });
    await new Promise(resolve => setTimeout(resolve, 20)); // tick

    const klines1m = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
    expect(klines1m).toHaveLength(1);
    expect(klines1m[0]).toMatchObject({
      market: 'SPOT',
      symbol: 'BTCUSDT',
      open: '60000.000000000000000000',
      high: '60000.000000000000000000',
      low: '60000.000000000000000000',
      close: '60000.000000000000000000',
      baseVolume: '1.000000000000000000',
      tradesCount: 1,
      isFinal: false,
    });
  });

  it('2. Subsequent trade updates candle correctly', async () => {
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't1', symbol: 'BTCUSDT', price: '60000', quantity: '1', isMaker: false, timestamp: 1600000020000 }
    });
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't2', symbol: 'BTCUSDT', price: '61000', quantity: '2', isMaker: false, timestamp: 1600000050000 }
    });
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't3', symbol: 'BTCUSDT', price: '59000', quantity: '0.5', isMaker: false, timestamp: 1600000055000 }
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    const klines = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
    expect(klines).toHaveLength(1);
    const k = klines[0];
    expect(k.open).toBe('60000.000000000000000000');
    expect(k.high).toBe('61000.000000000000000000');
    expect(k.low).toBe('59000.000000000000000000');
    expect(k.close).toBe('59000.000000000000000000');
    expect(k.baseVolume).toBe('3.500000000000000000');
    expect(k.tradesCount).toBe(3);
  });

  it('3. Duplicate trade events are ignored', async () => {
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 'dup1', symbol: 'BTCUSDT', price: '60000', quantity: '1', isMaker: false, timestamp: 1600000020000 }
    });
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 'dup1', symbol: 'BTCUSDT', price: '60000', quantity: '1', isMaker: false, timestamp: 1600000020000 }
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    const klines = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
    expect(klines[0].baseVolume).toBe('1.000000000000000000');
    expect(klines[0].tradesCount).toBe(1);
  });

  it('4. Out-of-order events maintain chronological CLOSE price', async () => {
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't1', symbol: 'ETHUSDT', price: '3000', quantity: '1', isMaker: false, timestamp: 1600000030000 }
    });
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't2', symbol: 'ETHUSDT', price: '3050', quantity: '1', isMaker: false, timestamp: 1600000025000 } // Older timestamp!
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    const klines = await klineService.getHistoricalKLines('SPOT', 'ETHUSDT', '1m');
    expect(klines[0].close).toBe('3000.000000000000000000'); // Remains the later trade chronologically
    expect(klines[0].high).toBe('3050.000000000000000000');
  });

  it('5. Spot and Futures isolation', async () => {
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 's1', symbol: 'BTCUSDT', price: '60000', quantity: '1', isMaker: false, timestamp: 1600000020000 }
    });
    eventBus.publish({
      type: 'futures.trade.executed',
      payload: { id: 'f1', symbol: 'BTCUSDT', price: '60100', quantity: '1', isMaker: false, createdAt: new Date(1600000020000) }
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    const spot = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
    const futures = await klineService.getHistoricalKLines('FUTURES', 'BTCUSDT', '1m');
    expect(spot[0].close).toBe('60000.000000000000000000');
    expect(futures[0].close).toBe('60100.000000000000000000');
  });

  it('6. Candle finalization sweep', async () => {
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't1', symbol: 'BTCUSDT', price: '60000', quantity: '1', isMaker: false, timestamp: 1600000020000 }
    });
    await new Promise(resolve => setTimeout(resolve, 20)); // tick
    
    // Trigger the internal sweep manually (Date.now() is 2026, closeTime is 2020, so it will finalize)
    await (klineService as any).finalizeCandles();
    await new Promise(resolve => setTimeout(resolve, 20)); // let DB update finish

    const klines = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
    expect(klines[0].isFinal).toBe(true);

    // Late event should NOT mutate a finalized candle
    eventBus.publish({
      type: 'market.trade',
      payload: { tradeId: 't2', symbol: 'BTCUSDT', price: '99999', quantity: '1', isMaker: false, timestamp: 1600000070000 }
    });
    await new Promise(resolve => setTimeout(resolve, 20));
    
    const klinesAfter = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
    expect(klinesAfter[0].high).toBe('60000.000000000000000000');
  });

  it('7. Handles invalid numerical values safely', async () => {
    // Isolate from the Phase 8.6 external market-data fallback: with no valid
    // candles persisted, getHistoricalKLines must NOT reach a live external
    // source and return external candles. Disable the fallback for this test.
    const externalEnabled = (env as any).EXTERNAL_MARKET_DATA_ENABLED;
    (env as any).EXTERNAL_MARKET_DATA_ENABLED = false;
    try {
      eventBus.publish({
        type: 'market.trade',
        payload: { tradeId: 'inv1', symbol: 'BTCUSDT', price: 'NaN', quantity: '1', isMaker: false, timestamp: 1600000020000 }
      });
      eventBus.publish({
        type: 'market.trade',
        payload: { tradeId: 'inv2', symbol: 'BTCUSDT', price: '60000', quantity: '-1', isMaker: false, timestamp: 1600000020000 }
      });
      await new Promise(resolve => setTimeout(resolve, 20));

      const klines = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m');
      expect(klines).toHaveLength(0); // Should skip invalid trades
    } finally {
      (env as any).EXTERNAL_MARKET_DATA_ENABLED = externalEnabled;
    }
  });
});

// ── Phase 8.6: External kline source selection (FUTURES primary/fallback URLs) ──────────
describe('Phase 8.6: External historical kline source selection (SPOT/FUTURES URLs)', () => {
  let db: DatabasePool;
  let klineService: KLineService;
  const originalFuturesUrl = (env as any).EXTERNAL_MARKET_DATA_FUTURES_URL;
  const originalSpotUrl = (env as any).EXTERNAL_MARKET_DATA_URL;

  beforeEach(async () => {
    db = new DatabasePool();
    await db.connect();
    klineService = new KLineService(db);
    (klineService as any).klineCache.clear();
    // Pin the env URLs so the assertions are deterministic.
    (env as any).EXTERNAL_MARKET_DATA_FUTURES_URL = 'https://futures.example.test/fapi/v1';
    (env as any).EXTERNAL_MARKET_DATA_URL = 'https://spot.example.test/api/v3';
    (env as any).EXTERNAL_MARKET_DATA_ENABLED = true;
  });

  afterEach(async () => {
    (env as any).EXTERNAL_MARKET_DATA_FUTURES_URL = originalFuturesUrl;
    (env as any).EXTERNAL_MARKET_DATA_URL = originalSpotUrl;
    vi.unstubAllGlobals();
  });

  // Binance-style kline row: [openTime, open, high, low, close, volume, closeTime, quoteVolume, trades]
  const binanceRow = [1600000020000, '60000', '61000', '59000', '60500', '1.5', 1600000025999, '90750', 12];

  function mockFetch(handler: (url: string, init?: any) => Promise<any>) {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: any) => handler(url, init)));
  }

  function okResponse(body: unknown) {
    return {
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => body,
    };
  }

  function failResponse(status = 451) {
    return {
      ok: false,
      status,
      statusText: `HTTP ${status}`,
      json: async () => ({}),
    };
  }

  it('FUTURES primary kline source uses env.EXTERNAL_MARKET_DATA_FUTURES_URL', async () => {
    const urls: string[] = [];
    mockFetch(async (url: string) => {
      urls.push(url);
      return okResponse([binanceRow]);
    });

    const klines = await klineService.getHistoricalKLines('FUTURES', 'PEPEUSDT', '5m', 10);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://futures.example.test/fapi/v1/klines?symbol=PEPEUSDT&interval=5m&limit=10');
    expect(klines).toHaveLength(1);
    expect(klines[0]).toMatchObject({
      market: 'FUTURES',
      symbol: 'PEPEUSDT',
      interval: '5m',
      open: '60000.000000000000000000',
      high: '61000.000000000000000000',
      low: '59000.000000000000000000',
      close: '60500.000000000000000000',
      baseVolume: '1.500000000000000000',
      quoteVolume: '90750.000000000000000000',
      tradesCount: 12,
      isFinal: true,
    });
  });

  it('FUTURES falls back to env.EXTERNAL_MARKET_DATA_URL when the futures host fails', async () => {
    const urls: string[] = [];
    mockFetch(async (url: string) => {
      urls.push(url);
      if (url.startsWith('https://futures.example.test')) return failResponse(451);
      return okResponse([binanceRow]);
    });

    const klines = await klineService.getHistoricalKLines('FUTURES', 'PEPEUSDT', '5m', 10);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('https://futures.example.test/fapi/v1/klines');
    expect(urls[1]).toBe('https://spot.example.test/api/v3/klines?symbol=PEPEUSDT&interval=5m&limit=10');
    expect(klines).toHaveLength(1);
    expect(klines[0].market).toBe('FUTURES');
  });

  it('returns [] (no throw) when both FUTURES sources fail', async () => {
    mockFetch(async (url: string) => {
      if (url.startsWith('https://futures.example.test')) return failResponse(451);
      return failResponse(503);
    });

    const klines = await klineService.getHistoricalKLines('FUTURES', 'PEPEUSDT', '5m', 10);
    expect(klines).toEqual([]);
  });

  it('SPOT primary kline source remains env.EXTERNAL_MARKET_DATA_URL (unchanged)', async () => {
    const urls: string[] = [];
    mockFetch(async (url: string) => {
      urls.push(url);
      return okResponse([binanceRow]);
    });

    const klines = await klineService.getHistoricalKLines('SPOT', 'PEPEUSDT', '5m', 10);

    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://spot.example.test/api/v3/klines?symbol=PEPEUSDT&interval=5m&limit=10');
    expect(klines).toHaveLength(1);
    expect(klines[0].market).toBe('SPOT');
  });

  it('SPOT falls back to api.binance.com/api/v3 when the primary spot host fails (unchanged)', async () => {
    const urls: string[] = [];
    mockFetch(async (url: string) => {
      urls.push(url);
      if (url.startsWith('https://spot.example.test')) return failResponse(451);
      if (url.startsWith('https://api.binance.com/api/v3')) return okResponse([binanceRow]);
      return failResponse(500);
    });

    const klines = await klineService.getHistoricalKLines('SPOT', 'PEPEUSDT', '5m', 10);

    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain('https://spot.example.test/api/v3/klines');
    expect(urls[1]).toContain('https://api.binance.com/api/v3/klines');
    expect(klines).toHaveLength(1);
    expect(klines[0].market).toBe('SPOT');
  });

  it('env.EXTERNAL_MARKET_DATA_FUTURES_URL defaults to the Binance Futures URL', () => {
    expect(originalFuturesUrl).toBe('https://fapi.binance.com/fapi/v1');
  });
});
