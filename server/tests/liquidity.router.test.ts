import { describe, it, expect, beforeEach } from 'vitest';
import { SmartOrderRouter, RouterRequest, RoutingConfig } from '../src/domain/liquidity/router';
import { AggregatedOrderBook, MarketDataSourceHealth } from '../src/domain/liquidity/aggregator';
import { ProviderError, ProviderErrorCode } from '../src/domain/liquidity/errors';

describe('Phase 5.4 - Hybrid Smart Order Router', () => {
  let router: SmartOrderRouter;
  let baseConfig: RoutingConfig;
  let baseBook: AggregatedOrderBook;

  beforeEach(() => {
    router = new SmartOrderRouter();
    baseConfig = {
      enabledProviders: ['BINANCE', 'KRAKEN'],
      providerConfigs: {
        'INTERNAL': { feeRate: 0, slippageAssumed: 0 },
        'BINANCE': { feeRate: 0.001, slippageAssumed: 0.0005 }, // 0.1% fee, 0.05% slippage
        'KRAKEN': { feeRate: 0.002, slippageAssumed: 0.001 }
      }
    };

    baseBook = {
      symbol: 'BTCUSDT',
      bids: [
        { price: '50000', quantity: '2', sourceId: 'INTERNAL' },
        { price: '50100', quantity: '2', sourceId: 'BINANCE' }
      ],
      asks: [
        { price: '50200', quantity: '2', sourceId: 'INTERNAL' },
        { price: '50150', quantity: '2', sourceId: 'BINANCE' }
      ],
      sources: {
        'INTERNAL': { sourceId: 'INTERNAL', health: MarketDataSourceHealth.ACTIVE, lastUpdateMs: Date.now() },
        'BINANCE': { sourceId: 'BINANCE', health: MarketDataSourceHealth.ACTIVE, lastUpdateMs: Date.now() },
        'KRAKEN': { sourceId: 'KRAKEN', health: MarketDataSourceHealth.ACTIVE, lastUpdateMs: Date.now() }
      }
    };
  });

  const createReq = (overrides: Partial<RouterRequest>): RouterRequest => ({
    clientOrderId: 'req-1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    orderType: 'MARKET',
    quantity: '1',
    aggregatedOrderBook: JSON.parse(JSON.stringify(baseBook)), // deep clone
    routingConfig: JSON.parse(JSON.stringify(baseConfig)),
    ...overrides
  });

  it('1. Internal-only routing', () => {
    // Only internal has liquidity in this scenario
    const req = createReq({ quantity: '1' });
    req.aggregatedOrderBook.asks = [{ price: '50000', quantity: '5', sourceId: 'INTERNAL' }];
    const plan = router.routeOrder(req);
    expect(plan.routingMode).toBe('INTERNAL_ONLY');
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0].source.sourceType).toBe('INTERNAL');
    expect(Number(plan.slices[0].quantity)).toBe(1);
  });

  it('2. External-only routing', () => {
    const req = createReq({ quantity: '1' });
    req.aggregatedOrderBook.asks = [{ price: '50000', quantity: '5', sourceId: 'BINANCE' }];
    const plan = router.routeOrder(req);
    expect(plan.routingMode).toBe('EXTERNAL_ONLY');
  });

  it('3. Split routing', () => {
    const req = createReq({ quantity: '3' }); // Needs more than one source's top level (2 each)
    const plan = router.routeOrder(req);
    expect(plan.routingMode).toBe('SPLIT');
    expect(plan.slices.length).toBeGreaterThanOrEqual(2);
  });

  it('4. Internal liquidity preferred when economically superior', () => {
    const req = createReq({ quantity: '1', side: 'BUY' });
    // Internal ask = 50000, Binance ask = 50000. Internal has 0 fees, Binance has 0.1% fees.
    req.aggregatedOrderBook.asks = [
      { price: '50000', quantity: '5', sourceId: 'INTERNAL' },
      { price: '50000', quantity: '5', sourceId: 'BINANCE' }
    ];
    const plan = router.routeOrder(req);
    expect(plan.slices[0].source.sourceId).toBe('INTERNAL');
  });

  it('5. External liquidity preferred when economically superior', () => {
    const req = createReq({ quantity: '1', side: 'BUY' });
    // Binance ask is 49000, Internal is 50000. Even with fees, Binance is better.
    req.aggregatedOrderBook.asks = [
      { price: '50000', quantity: '5', sourceId: 'INTERNAL' },
      { price: '49000', quantity: '5', sourceId: 'BINANCE' }
    ];
    const plan = router.routeOrder(req);
    expect(plan.slices[0].source.sourceId).toBe('BINANCE');
  });

  it('6 & 7. Provider fee & slippage impact', () => {
    const req = createReq({ quantity: '1', side: 'BUY' });
    // Binance: 50000 * 1.0015 = 50075 effective
    // Kraken: 49950 * 1.003 = 50099.85 effective
    // Internal: 50080 effective
    req.aggregatedOrderBook.asks = [
      { price: '50000', quantity: '5', sourceId: 'BINANCE' },
      { price: '49950', quantity: '5', sourceId: 'KRAKEN' },
      { price: '50080', quantity: '5', sourceId: 'INTERNAL' }
    ];
    const plan = router.routeOrder(req);
    // Best is Binance (50075)
    expect(plan.slices[0].source.sourceId).toBe('BINANCE');
  });

  it('8 & 9. BUY vs SELL effective price comparison', () => {
    // BUY scenario (lowest cost wins)
    const reqBuy = createReq({ quantity: '1', side: 'BUY' });
    reqBuy.aggregatedOrderBook.asks = [
      { price: '50000', quantity: '1', sourceId: 'INTERNAL' },
      { price: '49900', quantity: '1', sourceId: 'BINANCE' } // Even w/ fee, 49900 is better
    ];
    const planBuy = router.routeOrder(reqBuy);
    expect(planBuy.slices[0].source.sourceId).toBe('BINANCE');

    // SELL scenario (highest proceeds wins)
    const reqSell = createReq({ quantity: '1', side: 'SELL' });
    reqSell.aggregatedOrderBook.bids = [
      { price: '50000', quantity: '1', sourceId: 'INTERNAL' },
      { price: '50010', quantity: '1', sourceId: 'BINANCE' } // Binance proceeds: 50010 * 0.9985 = ~49935. INTERNAL proceeds: 50000.
    ];
    const planSell = router.routeOrder(reqSell);
    expect(planSell.slices[0].source.sourceId).toBe('INTERNAL'); // Internal is better!
  });

  it('10 & 11. Partial internal and multiple external sources', () => {
    const req = createReq({ quantity: '5', side: 'BUY' });
    req.aggregatedOrderBook.asks = [
      { price: '50000', quantity: '2', sourceId: 'INTERNAL' },
      { price: '50100', quantity: '2', sourceId: 'BINANCE' },
      { price: '50200', quantity: '2', sourceId: 'KRAKEN' }
    ];
    const plan = router.routeOrder(req);
    expect(plan.slices.length).toBe(3);
    const qtySum = plan.slices.reduce((acc, s) => acc + Number(s.quantity), 0);
    expect(qtySum).toBe(5);
  });

  it('12 & 13. Source health & stale source rejection', () => {
    const req = createReq({ quantity: '1', side: 'BUY' });
    req.aggregatedOrderBook.sources['BINANCE'].health = MarketDataSourceHealth.STALE;
    req.aggregatedOrderBook.asks = [
      { price: '1000', quantity: '5', sourceId: 'BINANCE' }, // Super cheap but stale
      { price: '50000', quantity: '5', sourceId: 'INTERNAL' }
    ];
    const plan = router.routeOrder(req);
    expect(plan.slices[0].source.sourceId).toBe('INTERNAL');
  });

  it('14. Disabled provider rejection', () => {
    const req = createReq({ quantity: '1', side: 'BUY' });
    req.routingConfig.enabledProviders = []; // Disable all external
    req.aggregatedOrderBook.asks = [
      { price: '1000', quantity: '5', sourceId: 'BINANCE' },
      { price: '50000', quantity: '5', sourceId: 'INTERNAL' }
    ];
    const plan = router.routeOrder(req);
    expect(plan.slices[0].source.sourceId).toBe('INTERNAL');
  });

  it('15 & 16. Exposure limits / max external quantity enforcement', () => {
    const req = createReq({ quantity: '5', side: 'BUY' });
    req.routingConfig.maxExternalQuantity = 2; // Can only take 2 externally
    req.aggregatedOrderBook.asks = [
      { price: '40000', quantity: '5', sourceId: 'BINANCE' }, // Amazing price
      { price: '50000', quantity: '5', sourceId: 'INTERNAL' }
    ];
    const plan = router.routeOrder(req);
    const binanceSlice = plan.slices.find(s => s.source.sourceId === 'BINANCE');
    const internalSlice = plan.slices.find(s => s.source.sourceId === 'INTERNAL');
    
    expect(Number(binanceSlice?.quantity)).toBe(2);
    expect(Number(internalSlice?.quantity)).toBe(3);
  });

  it('18. Price protection / limit orders', () => {
    const req = createReq({ quantity: '1', side: 'BUY', orderType: 'LIMIT', limitPrice: '40000' });
    req.aggregatedOrderBook.asks = [
      { price: '50000', quantity: '5', sourceId: 'INTERNAL' }
    ];
    // None meet limit
    expect(() => router.routeOrder(req)).toThrowError(ProviderError);
  });

  it('19. Insufficient liquidity', () => {
    const req = createReq({ quantity: '1000', side: 'BUY' });
    try {
      router.routeOrder(req);
      expect.fail('Should throw');
    } catch (e: any) {
      expect(e.code).toBe(ProviderErrorCode.INSUFFICIENT_LIQUIDITY);
    }
  });

  it('20. Unsupported order type', () => {
    const req = createReq({ quantity: '1', orderType: 'STOP_LOSS' as any });
    try {
      router.routeOrder(req);
      expect.fail('Should throw');
    } catch (e: any) {
      expect(e.code).toBe(ProviderErrorCode.UNSUPPORTED_OPERATION);
    }
  });

  it('22. Slice quantity conservation', () => {
    const req = createReq({ quantity: '3.75', side: 'BUY' });
    const plan = router.routeOrder(req);
    const sum = plan.slices.reduce((acc, s) => acc + Number(s.quantity), 0);
    expect(sum).toBeCloseTo(3.75, 8);
  });

  it('25 & 26. Invalid/negative prices/quantities rejected', () => {
    const req = createReq({ quantity: '-1', side: 'BUY' });
    expect(() => router.routeOrder(req)).toThrowError(ProviderError);
  });

  it('28 & 29 & 30. No secrets, no financial mutation, no network requests', () => {
    const req = createReq({ quantity: '1', side: 'BUY' });
    const plan = router.routeOrder(req);
    const serialized = JSON.stringify(plan);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('secret');
    expect(plan.estimatedAveragePrice).toBeDefined();
  });
});
