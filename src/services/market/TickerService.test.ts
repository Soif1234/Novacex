import { describe, it, expect, beforeEach } from 'vitest';
import { tickerService } from './TickerService';

/**
 * TickerService is backend-backed (REST /market/tickers + WS ticker:<symbol>). This suite
 * focuses on the null-safe normalization seam `updateTickerFromRest`, which is also the
 * regression guard for the prior undefined-`lastPrice` crash that had been silenced by a
 * skipped test. (The former Binance REST/WS behavior it used to cover no longer exists.)
 */
describe('TickerService — null-safe ticker normalization', () => {
  beforeEach(() => {
    tickerService.tickers.clear();
  });

  it('stores a valid ticker and exposes it via getters', () => {
    tickerService.updateTickerFromRest('BTCUSDT', {
      lastPrice: '60000',
      priceChangePercent: '5.0',
      quoteVolume: '100000',
      highPrice: '61000',
      lowPrice: '59000',
    });
    const t = tickerService.getTicker('BTCUSDT');
    expect(t).toBeDefined();
    expect(t?.lastPrice).toBe('60000');
    expect(t?.priceChangePercent).toBe('5.0');
    expect(t?.quoteVolume24h).toBe('100000');
    expect(t?.high24h).toBe('61000');
  });

  it('sanitizes NaN / Infinity / undefined numeric fields to 0 (regression guard)', () => {
    tickerService.updateTickerFromRest('DOGEUSDT', {
      lastPrice: 'NaN',
      priceChangePercent: 'Infinity',
      quoteVolume: 'undefined',
    });
    const t = tickerService.getTicker('DOGEUSDT');
    expect(t).toBeDefined();
    expect(t?.lastPrice).toBe('0');
    expect(t?.priceChangePercent).toBe('0');
    expect(t?.quoteVolume24h).toBe('0');
    expect(Number.isNaN(parseFloat(t!.lastPrice))).toBe(false);
  });

  it('ignores a missing/invalid item without throwing', () => {
    expect(() => tickerService.updateTickerFromRest('ETHUSDT', undefined as any)).not.toThrow();
    expect(tickerService.getTicker('ETHUSDT')).toBeUndefined();
  });

  it('routes 3-arg (type,symbol,item) into the correct spot/futures map', () => {
    tickerService.updateTickerFromRest('fapi', 'BTCUSDT', { lastPrice: '60000' });
    tickerService.updateTickerFromRest('api', 'ETHUSDT', { lastPrice: '3000' });
    expect(tickerService.getFuturesTicker('BTCUSDT')?.lastPrice).toBe('60000');
    expect(tickerService.getSpotTicker('ETHUSDT')?.lastPrice).toBe('3000');
    const symbols = tickerService.getAllTickers().map(t => t.symbol);
    expect(symbols).toContain('BTCUSDT');
    expect(symbols).toContain('ETHUSDT');
  });
});
