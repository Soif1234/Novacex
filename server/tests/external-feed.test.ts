import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { externalMarketFeedService, SUPPORTED_SYMBOLS, isSupportedSymbol } from '../src/services/market/external-feed.service';
import { marketDataService } from '../src/services/market/market.service';
import { klineService } from '../src/services/market/kline.service';
import { db } from '../src/config/database';

describe('ExternalMarketFeedService & Kline External Fallback', () => {
  beforeAll(async () => {
    await db.connect();
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(() => {
    marketDataService.reset();
  });

  afterEach(() => {
    externalMarketFeedService.stop();
  });

  it('1. should define all core supported symbols', () => {
    expect(SUPPORTED_SYMBOLS).toContain('BTCUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('ETHUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('SOLUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('XRPUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('DOGEUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('ADAUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('AVAXUSDT');
    expect(SUPPORTED_SYMBOLS).toContain('LINKUSDC');
    expect(SUPPORTED_SYMBOLS).toContain('BTCUSDC');
  });

  it('2. should dynamically validate supported symbol patterns', () => {
    expect(isSupportedSymbol('BTCUSDT')).toBe(true);
    expect(isSupportedSymbol('ETHUSDT')).toBe(true);
    expect(isSupportedSymbol('PEPEUSDT')).toBe(true);
    expect(isSupportedSymbol('SUIUSDT')).toBe(true);
    expect(isSupportedSymbol('INVALID_XYZ')).toBe(false);
  });

  it('3. should poll external tickers and populate Top ~200 pairs in MarketDataService', async () => {
    await externalMarketFeedService.pollTickers();

    const allTickers = marketDataService.getAllTickers();
    expect(allTickers.length).toBeGreaterThanOrEqual(50);

    const btcTicker = marketDataService.getTicker('BTCUSDT');
    expect(btcTicker).toBeDefined();
    expect(Number(btcTicker!.lastPrice)).toBeGreaterThan(0);
  });

  it('4. should update in-memory tickers when updateExternalTickers is called', () => {
    marketDataService.updateExternalTickers([
      {
        symbol: 'BTCUSDT',
        lastPrice: '78500.000000000000000000',
        bid: '78499.000000000000000000',
        ask: '78501.000000000000000000',
        high24h: '80000.000000000000000000',
        low24h: '76000.000000000000000000',
        volume24h: '1000.000000000000000000',
        quoteVolume24h: '78500000.000000000000000000',
        priceChange24h: '1500.000000000000000000',
        priceChangePercent24h: '1.950000000000000000',
        timestamp: Date.now(),
      },
    ]);

    const ticker = marketDataService.getTicker('BTCUSDT');
    expect(ticker).toBeDefined();
    expect(ticker!.lastPrice).toBe('78500.000000000000000000');
  });

  it('5. should fetch and cache external historical klines when DB has 0 trades', async () => {
    const klines = await klineService.getHistoricalKLines('SPOT', 'BTCUSDT', '1m', 10);
    expect(Array.isArray(klines)).toBe(true);
    expect(klines.length).toBeGreaterThan(0);
    expect(klines[0]).toHaveProperty('open');
    expect(klines[0]).toHaveProperty('close');
    expect(klines[0]).toHaveProperty('high');
    expect(klines[0]).toHaveProperty('low');
    expect(klines[0].symbol).toBe('BTCUSDT');
  });

  it('6. should reject invalid non-standard symbols from external kline fetching', async () => {
    const klines = await klineService.getHistoricalKLines('SPOT', 'INVALID_COIN_XYZ' as any, '1m', 10);
    expect(klines).toEqual([]);
  });
});
