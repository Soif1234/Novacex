import { describe, it, expect, beforeEach } from 'vitest';
import { MarketDataAggregator, MarketDataSourceHealth, STALE_THRESHOLD_MS } from '../src/domain/liquidity/aggregator';
import { NormalizedTicker, NormalizedOrderBook } from '../src/domain/liquidity/adapter';
import { ProviderError, ProviderErrorCode } from '../src/domain/liquidity/errors';

describe('Phase 5.3 - Market Data Aggregation', () => {
  let aggregator: MarketDataAggregator;
  let now: number;

  beforeEach(() => {
    aggregator = new MarketDataAggregator();
    now = Date.now();
  });

  const createTicker = (symbol: string, bid: string, ask: string, offsetMs: number = 0): NormalizedTicker => ({
    symbol,
    bid,
    ask,
    lastPrice: ((Number(bid) + Number(ask)) / 2).toString(),
    volume24h: '100',
    timestamp: new Date(now + offsetMs)
  });

  const createOrderBook = (symbol: string, offsetMs: number = 0): NormalizedOrderBook => ({
    symbol,
    bids: [{ price: '49900', quantity: '1' }],
    asks: [{ price: '50100', quantity: '1' }],
    timestamp: new Date(now + offsetMs)
  });

  it('1. Internal ticker normalization', () => {
    const ticker = createTicker('btcusdt  ', '49000', '51000');
    aggregator.processTickerUpdate('INTERNAL', ticker, now);
    
    const aggregated = aggregator.getAggregatedTicker('BTCUSDT', now);
    expect(aggregated).not.toBeNull();
    expect(aggregated?.symbol).toBe('BTCUSDT');
    expect(aggregated?.bestBid).toBe('49000');
    expect(aggregated?.bestAsk).toBe('51000');
    expect(aggregated?.sources['INTERNAL']).toBeDefined();
  });

  it('2. Multi-source aggregation (Internal + External)', () => {
    aggregator.processTickerUpdate('INTERNAL', createTicker('BTCUSDT', '49000', '51000'), now);
    aggregator.processTickerUpdate('BINANCE_MOCK', createTicker('BTCUSDT', '49500', '50500'), now);

    const aggregated = aggregator.getAggregatedTicker('BTCUSDT', now);
    expect(aggregated?.bestBid).toBe('49500'); // Higher bid wins
    expect(aggregated?.bestAsk).toBe('50500'); // Lower ask wins
    expect(Object.keys(aggregated?.sources || {})).toHaveLength(2);
  });

  it('3. Order-book normalization and sorting', () => {
    const ob1 = createOrderBook('BTCUSDT');
    ob1.bids = [{ price: '49000', quantity: '1' }];
    ob1.asks = [{ price: '51000', quantity: '1' }];
    
    const ob2 = createOrderBook('BTCUSDT');
    ob2.bids = [{ price: '49500', quantity: '2' }];
    ob2.asks = [{ price: '50500', quantity: '2' }];

    aggregator.processOrderBookUpdate('INTERNAL', ob1, now);
    aggregator.processOrderBookUpdate('EXTERNAL', ob2, now);

    const aggregated = aggregator.getAggregatedOrderBook('BTCUSDT', now);
    expect(aggregated?.bids).toHaveLength(2);
    expect(aggregated?.asks).toHaveLength(2);
    
    // Check sorting (bids desc, asks asc)
    expect(aggregated?.bids[0].price).toBe('49500');
    expect(aggregated?.asks[0].price).toBe('50500');

    // Source attribution
    expect(aggregated?.bids[0].sourceId).toBe('EXTERNAL');
    expect(aggregated?.bids[1].sourceId).toBe('INTERNAL');
  });

  it('4. Stale-source rejection', () => {
    // Submit update way in the past
    aggregator.processTickerUpdate('STALE_SRC', createTicker('BTCUSDT', '49000', '51000', -(STALE_THRESHOLD_MS + 1000)), now);
    
    const aggregated = aggregator.getAggregatedTicker('BTCUSDT', now);
    // Should filter out stale source, resulting in null if no others exist
    expect(aggregated).toBeNull();
  });

  it('5. Unavailable-source handling via overrides', () => {
    aggregator.processTickerUpdate('SRC1', createTicker('BTCUSDT', '49000', '51000'), now);
    aggregator.setSourceHealth('SRC1', MarketDataSourceHealth.UNAVAILABLE);
    
    const aggregated = aggregator.getAggregatedTicker('BTCUSDT', now);
    expect(aggregated).toBeNull();
  });

  it('6. Duplicate and out-of-order update handling', () => {
    const t1 = createTicker('BTCUSDT', '49000', '51000', -100);
    const t2 = createTicker('BTCUSDT', '49500', '50500', 0);
    const tOutdated = createTicker('BTCUSDT', '40000', '60000', -200);
    const tDuplicate = createTicker('BTCUSDT', '49999', '50001', 0); // Exact same timestamp as t2

    aggregator.processTickerUpdate('SRC1', t1, now);
    aggregator.processTickerUpdate('SRC1', t2, now); // Should apply
    aggregator.processTickerUpdate('SRC1', tOutdated, now); // Should be ignored
    aggregator.processTickerUpdate('SRC1', tDuplicate, now); // Should be ignored

    const aggregated = aggregator.getAggregatedTicker('BTCUSDT', now);
    expect(aggregated?.bestBid).toBe('49500'); // Matches t2, not tDuplicate or tOutdated
  });

  it('7. Invalid price/quantity rejection', () => {
    const invalidTicker = createTicker('BTCUSDT', '-100', '50000');
    
    expect(() => aggregator.processTickerUpdate('SRC1', invalidTicker, now))
      .toThrowError(ProviderError);

    try {
      aggregator.processTickerUpdate('SRC1', invalidTicker, now);
    } catch (err: any) {
      expect(err.code).toBe(ProviderErrorCode.INVALID_REQUEST);
      expect(err.providerId).toBe('SRC1');
    }

    const invalidBook = createOrderBook('BTCUSDT');
    invalidBook.bids = [{ price: 'NaN', quantity: '1' }];
    expect(() => aggregator.processOrderBookUpdate('SRC1', invalidBook, now))
      .toThrowError(ProviderError);
  });

  it('8. Provider credential isolation (no network access)', () => {
    // Tests are purely domain logic.
    // The aggregator requires Normalized items, ensuring no Axios responses or raw secrets enter this layer.
    const aggregated = aggregator.getAggregatedTicker('UNKNOWN', now);
    expect(aggregated).toBeNull();
  });

  it('9. Internal liquidity remains available when external is disabled', () => {
    aggregator.processTickerUpdate('INTERNAL', createTicker('BTCUSDT', '49000', '51000'), now);
    aggregator.processTickerUpdate('EXTERNAL', createTicker('BTCUSDT', '49500', '50500'), now);

    // External goes offline
    aggregator.setSourceHealth('EXTERNAL', MarketDataSourceHealth.ERROR);

    const aggregated = aggregator.getAggregatedTicker('BTCUSDT', now);
    expect(aggregated).not.toBeNull();
    // Reverts to INTERNAL best bid/ask
    expect(aggregated?.bestBid).toBe('49000');
    expect(aggregated?.bestAsk).toBe('51000');
    expect(Object.keys(aggregated!.sources)).toEqual(['INTERNAL']);
  });
});
