import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LedgerService } from '../wallet/LedgerService';
import { DemoLedger } from '../ledger';
import { FuturesOrderService } from './FuturesOrderService';
import { futuresMarketService } from './FuturesMarketService';

describe('Phase 1 Correct Regression Tests — Lifecycle & Service Reinitialization', () => {
  beforeEach(() => {
    vi.spyOn(futuresMarketService, 'getMarket').mockResolvedValue({
      symbol: 'BTCUSDT',
      lastPrice: '50000',
      maintenanceMarginRate: '0.005',
      minimumQuantity: '0.001',
      maximumLeverage: 125,
      makerFee: '0.0002',
      takerFee: '0.0004'
    } as any);
  });

  it('1. CLEAN INITIALIZATION — initializes fresh service state with default balances', () => {
    sessionStorage.clear();

    const ledger = new LedgerService(true);
    const demoLedger = new DemoLedger(true);

    expect(ledger.getBalance('USDT')).toBe('10000');
    expect(ledger.getBalance('FUTURES_USDT')).toBe('0');
    expect(demoLedger.getBalance('USDT')).toBe('10000');
    expect(demoLedger.getBalance('FUTURES_USDT')).toBe('0');
  });

  it('2, 3 & 4. PERSISTENCE & 5 REINITIALIZATION CYCLES — state survives new instance re-instantiation', async () => {
    sessionStorage.clear();

    // 1. Initial setup with Instance 0
    let currentDemoLedger: DemoLedger | null = new DemoLedger(true);
    let currentFuturesService: FuturesOrderService | null = new FuturesOrderService(currentDemoLedger, true);

    currentDemoLedger.credit('FUTURES_USDT', '10000', 'Init Futures');
    expect(currentDemoLedger.getBalance('FUTURES_USDT')).toBe('10000');

    // Place LIMIT order (0.1 BTC at 40,000 USDT with 10x leverage = 400 USDT initial margin)
    const placedOrder = await currentFuturesService.placeOrder({
      accountId: 'test-user-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '40000',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const recordedOrderId = placedOrder.id;
    expect(placedOrder.status).toBe('PENDING');
    expect(currentDemoLedger.getBalance('FUTURES_USDT')).toBe('9600');

    // Perform 5 consecutive reinitialization cycles with completely new service instances
    for (let cycle = 1; cycle <= 5; cycle++) {
      // Destroy existing references without clearing sessionStorage
      currentDemoLedger = null;
      currentFuturesService = null;

      // Re-instantiate brand new service instances from persistent storage
      const rehydratedDemoLedger = new DemoLedger(true);
      const rehydratedFuturesService = new FuturesOrderService(rehydratedDemoLedger, true);

      // Verify state loaded into new instances
      const loadedOrders = rehydratedFuturesService.getOrders('test-user-1');
      expect(loadedOrders.length).toBe(1);

      const targetOrder = loadedOrders.find(o => o.id === recordedOrderId);
      expect(targetOrder).toBeDefined();
      expect(targetOrder?.status).toBe('PENDING');
      expect(targetOrder?.price).toBe('40000');
      expect(targetOrder?.quantity).toBe('0.1');

      // Verify reserved margin remains exactly once (9600 USDT, not 9200, not 10000)
      expect(rehydratedDemoLedger.getBalance('FUTURES_USDT')).toBe('9600');

      currentDemoLedger = rehydratedDemoLedger;
      currentFuturesService = rehydratedFuturesService;
    }

    // 6. Cancellation on the 5th reinitialized instance
    await currentFuturesService!.cancelOrder(recordedOrderId);

    // Reserved margin released exactly once back to 10000 USDT
    expect(currentDemoLedger!.getBalance('FUTURES_USDT')).toBe('10000');

    const finalOrders = currentFuturesService!.getOrders('test-user-1');
    const cancelledOrder = finalOrders.find(o => o.id === recordedOrderId);
    expect(cancelledOrder?.status).toBe('CANCELLED');
  });

  it('6 & H. ACCOUNTING & DUPLICATE DEBIT PROTECTION — full lifecycle and edge cases', async () => {
    sessionStorage.clear();

    const demoLedger = new DemoLedger(true);
    demoLedger.reset();
    const service = new FuturesOrderService(demoLedger, true);

    demoLedger.credit('FUTURES_USDT', '10000', 'Init');

    // 1. Placement reserves margin once
    const order = await service.placeOrder({
      accountId: 'test-acc',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '40000',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('PENDING');
    expect(demoLedger.getBalance('FUTURES_USDT')).toBe('6000'); // 10000 - 4000

    // 2. Cancellation releases reservation once
    await service.cancelOrder(order.id);
    expect(demoLedger.getBalance('FUTURES_USDT')).toBe('10000');

    // 3. Duplicate cancellation throws and cannot double-credit
    await expect(service.cancelOrder(order.id)).rejects.toThrow();
    expect(demoLedger.getBalance('FUTURES_USDT')).toBe('10000');
  });
});
