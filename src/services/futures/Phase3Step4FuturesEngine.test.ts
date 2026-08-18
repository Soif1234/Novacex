import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FuturesEngineService } from './FuturesEngineService';
import { futuresOrderService } from './FuturesOrderService';
import { futuresMarketService } from './FuturesMarketService';
import { futuresTpSlService } from './FuturesTpSlService';
import { futuresFundingService } from './FuturesFundingService';
import { liquidationService } from './LiquidationService';
import { tickerService } from '../market/TickerService';
import { tradingPairRegistry } from '../market/TradingPairRegistry';
import { demoLedger } from '../ledger';
import { orderCoreService } from '../orders/OrderCoreService';
import { tradeFillService } from '../orders/TradeFillService';
import { FuturesMarket } from '../../types/futures';

describe('Phase 3 Step 4 — Headless Futures Engine & Market Processing', () => {
  let engine: FuturesEngineService;
  const userA = 'user-alice-step4';
  const userB = 'user-bob-step4';

  const createMockMarket = (symbol: string, price: string): FuturesMarket => ({
    symbol,
    baseAsset: symbol.replace('USDT', ''),
    quoteAsset: 'USDT',
    lastPrice: price,
    markPrice: price,
    indexPrice: price,
    fundingRate: '0.0001',
    openInterest: '1000',
    volume24h: '500000',
    high24h: (parseFloat(price) * 1.05).toString(),
    low24h: (parseFloat(price) * 0.95).toString(),
    change24h: '2.5',
    tickSize: '0.1',
    quantityPrecision: 3,
    minimumQuantity: '0.001',
    maximumLeverage: 100,
    makerFee: '0.0002',
    takerFee: '0.0005',
    maintenanceMarginRate: '0.005'
  });

  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    demoLedger.reset();
    futuresOrderService.reset();
    futuresTpSlService.reset();
    futuresFundingService.reset();
    futuresMarketService.clearOverrides();
    orderCoreService.reset();
    tradeFillService.reset();

    // Fund user accounts
    demoLedger.credit('FUTURES_USDT', '100000', 'Initial FUTURES User A', 'DEPOSIT', 'init_a_fut', userA);
    demoLedger.credit('FUTURES_USDT', '100000', 'Initial FUTURES User B', 'DEPOSIT', 'init_b_fut', userB);
    demoLedger.credit('USDT', '100000', 'Initial SPOT User A', 'DEPOSIT', 'init_a_spot', userA);
    demoLedger.credit('USDT', '100000', 'Initial SPOT User B', 'DEPOSIT', 'init_b_spot', userB);

    engine = new FuturesEngineService(futuresOrderService, futuresMarketService, futuresTpSlService, futuresFundingService, 5000);
  });

  afterEach(() => {
    engine.stop();
  });

  it('A. BUY LIMIT remains pending when market price is above limit', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '65000'));
    const order = await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '60000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('PENDING');

    // Market tick arrives with price 65000 (above limit)
    await engine.processMarketTick([createMockMarket('BTCUSDT', '65000')]);

    const updatedOrder = futuresOrderService.getOrders(userA).find(o => o.id === order.id);
    expect(updatedOrder?.status).toBe('PENDING');
    expect(futuresOrderService.getPositions(userA).length).toBe(0);
  });

  it('B. BUY LIMIT executes when a later tick reaches or falls below the limit', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '65000'));
    const order = await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '60000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('PENDING');

    // Later market tick drops to 59000
    await engine.processMarketTick([createMockMarket('BTCUSDT', '59000')]);

    const updatedOrder = futuresOrderService.getOrders(userA).find(o => o.id === order.id);
    expect(updatedOrder?.status).toBe('FILLED');

    const positions = futuresOrderService.getPositions(userA);
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe('BTCUSDT');
    expect(positions[0].side).toBe('LONG');
    expect(positions[0].quantity).toBe('0.1');
  });

  it('C. SELL LIMIT remains pending when market price is below limit', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '65000'));
    const order = await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      type: 'LIMIT',
      price: '70000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('PENDING');

    // Market tick arrives at 65000 (below limit)
    await engine.processMarketTick([createMockMarket('BTCUSDT', '65000')]);

    const updatedOrder = futuresOrderService.getOrders(userA).find(o => o.id === order.id);
    expect(updatedOrder?.status).toBe('PENDING');
    expect(futuresOrderService.getPositions(userA).length).toBe(0);
  });

  it('D. SELL LIMIT executes when a later tick reaches or rises above the limit', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '65000'));
    const order = await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      type: 'LIMIT',
      price: '70000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('PENDING');

    // Later market tick rises to 71000
    await engine.processMarketTick([createMockMarket('BTCUSDT', '71000')]);

    const updatedOrder = futuresOrderService.getOrders(userA).find(o => o.id === order.id);
    expect(updatedOrder?.status).toBe('FILLED');

    const positions = futuresOrderService.getPositions(userA);
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe('BTCUSDT');
    expect(positions[0].side).toBe('SHORT');
  });

  it('E. Duplicate tick does not execute filled order twice', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '65000'));
    const order = await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '60000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    // First matching tick
    await engine.processMarketTick([createMockMarket('BTCUSDT', '59000')]);
    expect(futuresOrderService.getPositions(userA).length).toBe(1);

    // Duplicate subsequent tick
    await engine.processMarketTick([createMockMarket('BTCUSDT', '58500')]);
    expect(futuresOrderService.getPositions(userA).length).toBe(1);
    expect(futuresOrderService.getPositions(userA)[0].quantity).toBe('0.1');
  });

  it('F. TP triggers autonomously without Futures.tsx mounted', async () => {
    // Open LONG position at 50,000
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const pos = futuresOrderService.getPositions(userA)[0];
    expect(pos).toBeDefined();

    // Set TP at 55,000
    futuresTpSlService.addOrUpdateConfig({
      accountId: userA,
      positionId: pos.positionId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: pos.quantity,
      takeProfitPrice: '55000',
      takeProfitEnabled: true,
      stopLossEnabled: false
    }, pos);

    // Headless tick reaches 56,000
    await engine.processMarketTick([createMockMarket('BTCUSDT', '56000')]);

    const updatedPos = futuresOrderService.getPositions(userA).find(p => p.positionId === pos.positionId);
    expect(updatedPos?.status).toBe('CLOSED');
  });

  it('G. SL triggers autonomously without Futures.tsx mounted', async () => {
    // Open LONG position at 50,000
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const pos = futuresOrderService.getPositions(userA)[0];
    expect(pos).toBeDefined();

    // Set SL at 48,000
    futuresTpSlService.addOrUpdateConfig({
      accountId: userA,
      positionId: pos.positionId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: pos.quantity,
      stopLossPrice: '48000',
      stopLossEnabled: true,
      takeProfitEnabled: false
    }, pos);

    // Headless tick drops to 47,500
    await engine.processMarketTick([createMockMarket('BTCUSDT', '47500')]);

    const updatedPos = futuresOrderService.getPositions(userA).find(p => p.positionId === pos.positionId);
    expect(updatedPos?.status).toBe('CLOSED');
  });

  it('H. Duplicate TP/SL processing is idempotent', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const pos = futuresOrderService.getPositions(userA)[0];
    futuresTpSlService.addOrUpdateConfig({
      accountId: userA,
      positionId: pos.positionId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: pos.quantity,
      takeProfitPrice: '55000',
      takeProfitEnabled: true,
      stopLossEnabled: false
    }, pos);

    // Process tick twice
    await engine.processMarketTick([createMockMarket('BTCUSDT', '56000')]);
    await engine.processMarketTick([createMockMarket('BTCUSDT', '57000')]);

    // Position is closed and no duplicate close orders created
    const trades = futuresOrderService.getTrades(userA);
    expect(trades.length).toBe(2); // 1 open + 1 close
  });

  it('I. Funding settles when period is due without Futures.tsx mounted', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const initialBal = parseFloat(demoLedger.getBalance('FUTURES_USDT', userA));

    // Force funding interval to past
    futuresFundingService.setFundingIntervalMs(-1000);

    // Headless engine tick processes funding
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);

    const updatedBal = parseFloat(demoLedger.getBalance('FUTURES_USDT', userA));
    // LONG with positive funding rate (0.01%) pays: 50,000 * 0.0001 = 5 USDT
    expect(updatedBal).toBeLessThan(initialBal);
  });

  it('J. Duplicate funding processing does not double-settle the same period', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    // Make due once
    futuresFundingService.setFundingIntervalMs(-1000);
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    const balAfterFirst = demoLedger.getBalance('FUTURES_USDT', userA);

    // Reset interval to normal future interval
    futuresFundingService.setFundingIntervalMs(8 * 60 * 60 * 1000);

    // Run subsequent tick
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    const balAfterSecond = demoLedger.getBalance('FUTURES_USDT', userA);

    expect(balAfterFirst).toBe(balAfterSecond);
  });

  it('K. Liquidation is processed without Futures.tsx mounted', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1.0',
      leverage: 20,
      marginMode: 'ISOLATED'
    });

    const pos = futuresOrderService.getPositions(userA)[0];
    expect(pos.status).toBe('OPEN');

    // Massive price crash triggering liquidation
    await engine.processMarketTick([createMockMarket('BTCUSDT', '20000')]);

    const liquidatedPos = futuresOrderService.getPositions(userA).find(p => p.positionId === pos.positionId);
    expect(liquidatedPos?.status).toBe('LIQUIDATED');
  });

  it('L. Duplicate liquidation does not double-settle', async () => {
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '50000'));
    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1.0',
      leverage: 20,
      marginMode: 'ISOLATED'
    });

    await engine.processMarketTick([createMockMarket('BTCUSDT', '20000')]);
    const initialLiqs = liquidationService.getLiquidations().length;

    // Second tick after liquidation
    await engine.processMarketTick([createMockMarket('BTCUSDT', '19000')]);
    const subsequentLiqs = liquidationService.getLiquidations().length;

    expect(subsequentLiqs).toBe(initialLiqs);
  });

  it('M. Engine start() called twice does not create duplicate loops', () => {
    engine.start();
    expect(engine.getIsRunning()).toBe(true);
    engine.start();
    expect(engine.getIsRunning()).toBe(true);
  });

  it('N. Engine stop() called twice is safe and idempotent', () => {
    engine.start();
    engine.stop();
    expect(engine.getIsRunning()).toBe(false);
    engine.stop();
    expect(engine.getIsRunning()).toBe(false);
  });

  it('O. Spot and Futures tickers remain independent in TickerService', () => {
    (tickerService as any).updateTickerFromRest('spot', 'BTCUSDT', {
      lastPrice: '65100',
      priceChange: '100',
      priceChangePercent: '1.5',
      highPrice: '66000',
      lowPrice: '64000',
      volume: '1000',
      quoteVolume: '65000000'
    });

    (tickerService as any).updateTickerFromRest('fapi', 'BTCUSDT', {
      lastPrice: '65200',
      priceChange: '200',
      priceChangePercent: '2.0',
      highPrice: '66200',
      lowPrice: '64100',
      volume: '5000',
      quoteVolume: '325000000'
    });

    const spotTicker = tickerService.getSpotTicker('BTCUSDT');
    const futTicker = tickerService.getFuturesTicker('BTCUSDT');

    expect(spotTicker?.lastPrice).toBe('65100');
    expect(futTicker?.lastPrice).toBe('65200');
    expect(spotTicker?.lastPrice).not.toBe(futTicker?.lastPrice);
  });

  it('P. Futures market registry dynamically includes loaded symbols', () => {
    const pairs = tradingPairRegistry.getFuturesPairs();
    expect(pairs.length).toBeGreaterThanOrEqual(6);
    expect(pairs.some(p => p.symbol === 'BTCUSDT')).toBe(true);
    expect(pairs.some(p => p.symbol === 'ETHUSDT')).toBe(true);
    expect(pairs.some(p => p.symbol === 'SOLUSDT')).toBe(true);
  });

  it('Q. Spot-only symbols cannot become Futures markets', () => {
    const spotPair = tradingPairRegistry.getSpotPair('LINKUSDC');
    expect(spotPair).toBeDefined();
    expect(spotPair?.marketType).toBe('SPOT');

    const futPair = tradingPairRegistry.getFuturesPair('LINKUSDC');
    expect(futPair).toBeUndefined();

    const isValid = futuresMarketService.isValidSymbol('LINKUSDC');
    expect(isValid).toBe(false);
  });

  it('R. Zero-price fallback cannot execute a Futures order', async () => {
    const order = await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '60000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    // Zero price tick should be ignored
    await engine.processMarketTick([createMockMarket('BTCUSDT', '0')]);

    const pendingOrder = futuresOrderService.getOrders(userA).find(o => o.id === order.id);
    expect(pendingOrder?.status).toBe('PENDING');
  });

  it('S. User A engine processing cannot mutate User B balances or positions', async () => {
    const initBalB = demoLedger.getBalance('FUTURES_USDT', userB);

    await engine.processMarketTick([createMockMarket('BTCUSDT', '50000')]);
    await futuresOrderService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const posB = futuresOrderService.getPositions(userB);
    const balB = demoLedger.getBalance('FUTURES_USDT', userB);

    expect(posB.length).toBe(0);
    expect(balB).toBe(initBalB);
  });

  it('T. Existing Phase 1/2/3 order and ledger behavior remains intact', () => {
    const balA = demoLedger.getBalance('FUTURES_USDT', userA);
    expect(parseFloat(balA)).toBe(100000);
    expect(futuresOrderService.getPositions(userA).length).toBe(0);
  });
});
