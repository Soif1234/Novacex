import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabasePool } from '../src/config/database';
import { KLineService } from '../src/services/market/kline.service';
import { eventBus } from '../src/services/market/event-bus';

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
  });
});
