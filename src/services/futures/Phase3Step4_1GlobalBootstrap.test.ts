import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { futuresEngineService } from './FuturesEngineService';
import { futuresOrderService } from './FuturesOrderService';
import { futuresMarketService } from './FuturesMarketService';
import { demoLedger } from '../ledger';
import { FuturesMarket } from '../../types/futures';

describe('Phase 3 Step 4.1 — Global Futures Engine Bootstrap', () => {
  const testUser = 'user-bootstrap-test';

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
    futuresMarketService.clearOverrides();
    demoLedger.credit('FUTURES_USDT', '100000', 'Initial Deposit', 'DEPOSIT', 'init_boot', testUser);
  });

  afterEach(() => {
    futuresEngineService.stop();
  });

  it('1. Engine starts exactly once and sets isRunning to true', () => {
    expect(futuresEngineService.getIsRunning()).toBe(false);

    futuresEngineService.start();
    expect(futuresEngineService.getIsRunning()).toBe(true);

    // Second call to start is idempotent
    futuresEngineService.start();
    expect(futuresEngineService.getIsRunning()).toBe(true);
  });

  it('2. React remount or duplicate start calls do not create multiple intervals', () => {
    const setIntervalSpy = vi.spyOn(global, 'setInterval');

    futuresEngineService.start();
    const initialCallCount = setIntervalSpy.mock.calls.length;

    // Simulate subsequent component mount calling start again
    futuresEngineService.start();
    expect(setIntervalSpy.mock.calls.length).toBe(initialCallCount);

    setIntervalSpy.mockRestore();
  });

  it('3. Engine processes background cycles and executes LIMIT orders without Futures.tsx mounted', async () => {
    futuresEngineService.start();
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '65000'));

    const order = await futuresOrderService.placeOrder({
      accountId: testUser,
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

    // Simulate background tick arrival via market service override and processMarketTick
    futuresMarketService.setMarketOverride('BTCUSDT', createMockMarket('BTCUSDT', '59000'));
    await futuresEngineService.runCycle();

    const updated = futuresOrderService.getOrders(testUser).find(o => o.id === order.id);
    expect(updated?.status).toBe('FILLED');

    const positions = futuresOrderService.getPositions(testUser);
    expect(positions.length).toBe(1);
    expect(positions[0].symbol).toBe('BTCUSDT');
    expect(positions[0].side).toBe('LONG');
  });

  it('4. stop() cleanly terminates the running state', () => {
    futuresEngineService.start();
    expect(futuresEngineService.getIsRunning()).toBe(true);

    futuresEngineService.stop();
    expect(futuresEngineService.getIsRunning()).toBe(false);

    // Subsequent stop is idempotent
    futuresEngineService.stop();
    expect(futuresEngineService.getIsRunning()).toBe(false);
  });
});
