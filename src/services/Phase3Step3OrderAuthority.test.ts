import { describe, it, expect, beforeEach, vi } from 'vitest';
import { orderService } from './OrderService';
import { futuresOrderService } from './futures/FuturesOrderService';
import { orderCoreService } from './orders/OrderCoreService';
import { tradeFillService } from './orders/TradeFillService';
import { tradeService } from './TradeService';
import { demoLedger } from './ledger';
import { syncOrderToCore, syncFillToCore } from './orders/integration';

describe.skip('Phase 3 Step 3 — Order Authority Unification', () => {
  const userA = 'user-alice-step3';
  const userB = 'user-bob-step3';

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] } as any);
    sessionStorage.clear();
    localStorage.clear();
    demoLedger.reset();
    orderService.reset();
    futuresOrderService.reset();
    tradeService.reset();
    orderCoreService.reset();
    tradeFillService.reset();

    // Fund user accounts for testing
    demoLedger.credit('USDT', '50000', 'Initial USDT User A', 'DEPOSIT', 'init_a_spot', userA);
    demoLedger.credit('FUTURES_USDT', '50000', 'Initial FUTURES User A', 'DEPOSIT', 'init_a_fut', userA);
    demoLedger.credit('USDT', '50000', 'Initial USDT User B', 'DEPOSIT', 'init_b_spot', userB);
    demoLedger.credit('FUTURES_USDT', '50000', 'Initial FUTURES User B', 'DEPOSIT', 'init_b_fut', userB);
  });

  it('1. One Spot order creates one canonical order projection', async () => {
    const spotOrder = await orderService.placeOrder({
      id: 'spot-ord-1',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const coreOrders = orderCoreService.getOrders(userA);
    expect(coreOrders.length).toBe(1);
    expect(coreOrders[0].id).toBe(spotOrder.id);
    expect(coreOrders[0].userId).toBe(userA);
    expect(coreOrders[0].market).toBe('SPOT');
    expect(coreOrders[0].status).toBe('OPEN');
    expect(coreOrders[0].quantity).toBe('0.1');
    expect(coreOrders[0].price).toBe('20000');
  });

  it('2. One Futures order creates one canonical order projection', async () => {
    const futOrder = await futuresOrderService.placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.5',
      leverage: 10,
      marginMode: 'ISOLATED',
      accountId: userA
    });

    const coreOrders = orderCoreService.getOrders(userA);
    expect(coreOrders.length).toBe(1);
    expect(coreOrders[0].id).toBe(futOrder.id);
    expect(coreOrders[0].userId).toBe(userA);
    expect(coreOrders[0].market).toBe('FUTURES');
    expect(coreOrders[0].status).toBe('OPEN');
    expect(coreOrders[0].quantity).toBe('0.5');
    expect(coreOrders[0].price).toBe('20000');
  });

  it('3. Duplicate order sync does not create duplicate records', () => {
    syncOrderToCore('ord-dup-1', userA, 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '1.0', '50000', undefined, 'NEW');
    syncOrderToCore('ord-dup-1', userA, 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '1.0', '50000', undefined, 'NEW');
    syncOrderToCore('ord-dup-1', userA, 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '1.0', '50000', undefined, 'OPEN');

    const orders = orderCoreService.getOrders(userA);
    expect(orders.length).toBe(1);
    expect(orders[0].id).toBe('ord-dup-1');
    expect(orders[0].status).toBe('OPEN');
  });

  it('4. LIMIT fill updates the canonical order once', () => {
    syncOrderToCore('ord-fill-1', userA, 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '2.0', '50000', undefined, 'OPEN');
    syncFillToCore('fill-1', 'ord-fill-1', userA, 'BTCUSDT', 'SPOT', 'BUY', '1.0', '50000', '5', 'USDT');

    const order = orderCoreService.getOrder('ord-fill-1');
    expect(order).toBeDefined();
    expect(order?.executedQuantity).toBe('1');
    expect(order?.remainingQuantity).toBe('1');
    expect(order?.status).toBe('PARTIALLY_FILLED');

    syncFillToCore('fill-2', 'ord-fill-1', userA, 'BTCUSDT', 'SPOT', 'BUY', '1.0', '50000', '5', 'USDT');
    const updatedOrder = orderCoreService.getOrder('ord-fill-1');
    expect(updatedOrder?.executedQuantity).toBe('2');
    expect(updatedOrder?.remainingQuantity).toBe('0');
    expect(updatedOrder?.status).toBe('FILLED');
  });

  it('5. Duplicate fill does not create duplicate fills', () => {
    syncOrderToCore('ord-fill-dup', userA, 'ETHUSDT', 'FUTURES', 'LONG', 'MARKET', '10', undefined, undefined, 'NEW');
    syncFillToCore('fill-dup-1', 'ord-fill-dup', userA, 'ETHUSDT', 'FUTURES', 'LONG', '10', '3000', '1', 'USDT');
    syncFillToCore('fill-dup-1', 'ord-fill-dup', userA, 'ETHUSDT', 'FUTURES', 'LONG', '10', '3000', '1', 'USDT'); // duplicate call

    const fills = tradeFillService.getFillsByOrder('ord-fill-dup', userA);
    expect(fills.length).toBe(1);
    expect(fills[0].id).toBe('fill-dup-1');

    const order = orderCoreService.getOrder('ord-fill-dup');
    expect(order?.executedQuantity).toBe('10'); // not 20
  });

  it('6. Cancellation updates the canonical order once', async () => {
    const spotOrder = await orderService.placeOrder({
      id: 'spot-ord-cancel',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    orderService.cancelOrder(spotOrder.id);
    const coreOrder = orderCoreService.getOrder(spotOrder.id);
    expect(coreOrder?.status).toBe('CANCELLED');
  });

  it('7. Duplicate cancellation does not duplicate state', async () => {
    const spotOrder = await orderService.placeOrder({
      id: 'spot-ord-dup-cancel',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    orderService.cancelOrder(spotOrder.id);
    expect(() => orderService.cancelOrder(spotOrder.id)).toThrow('Only PENDING orders can be cancelled');

    const coreOrders = orderCoreService.getOrders(userA);
    expect(coreOrders.length).toBe(1);
    expect(coreOrders[0].status).toBe('CANCELLED');
  });

  it('8. Trade/fill history corresponds to the canonical order', () => {
    syncOrderToCore('ord-hist-1', userA, 'SOLUSDT', 'SPOT', 'BUY', 'MARKET', '5', '150', undefined, 'NEW');
    syncFillToCore('fill-hist-1', 'ord-hist-1', userA, 'SOLUSDT', 'SPOT', 'BUY', '5', '150', '0.1', 'USDT');

    const fills = tradeFillService.getFillsByOrder('ord-hist-1', userA);
    expect(fills.length).toBe(1);
    expect(fills[0].orderId).toBe('ord-hist-1');
    expect(fills[0].price).toBe('150');
    expect(fills[0].quantity).toBe('5');
    expect(fills[0].userId).toBe(userA);
  });

  it('9. User A cannot retrieve User B\'s orders', async () => {
    await orderService.placeOrder({
      id: 'spot-user-a',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await orderService.placeOrder({
      id: 'spot-user-b',
      accountId: userB,
      symbol: 'ETHUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '1500',
      quantity: '1.0',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const userAOrders = orderCoreService.getOrders(userA);
    const userBOrders = orderCoreService.getOrders(userB);

    expect(userAOrders.length).toBe(1);
    expect(userAOrders[0].symbol).toBe('BTCUSDT');
    expect(userAOrders[0].userId).toBe(userA);

    expect(userBOrders.length).toBe(1);
    expect(userBOrders[0].symbol).toBe('ETHUSDT');
    expect(userBOrders[0].userId).toBe(userB);
  });

  it('10. User A cannot retrieve User B\'s fills', () => {
    syncFillToCore('fill-a', 'ord-a', userA, 'BTCUSDT', 'SPOT', 'BUY', '1', '50000', '5', 'USDT');
    syncFillToCore('fill-b', 'ord-b', userB, 'ETHUSDT', 'SPOT', 'BUY', '2', '3000', '2', 'USDT');

    const userAFills = tradeFillService.getTradeHistory(userA);
    const userBFills = tradeFillService.getTradeHistory(userB);

    expect(userAFills.length).toBe(1);
    expect(userAFills[0].id).toBe('fill-a');
    expect(userAFills[0].userId).toBe(userA);

    expect(userBFills.length).toBe(1);
    expect(userBFills[0].id).toBe('fill-b');
    expect(userBFills[0].userId).toBe(userB);
  });

  it('11. Spot behavior remains correct (locking and unlocking funds)', async () => {
    const spotInitial = demoLedger.getBalance('USDT', userA);
    const spotOrder = await orderService.placeOrder({
      id: 'spot-ord-lock',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.5',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    // 0.5 * 20000 = 10000 locked
    expect(demoLedger.getBalance('USDT', userA)).toBe((Number(spotInitial) - 10000).toString());

    orderService.cancelOrder(spotOrder.id);
    // 10000 refunded
    expect(demoLedger.getBalance('USDT', userA)).toBe(spotInitial);
  });

  it('12. Futures behavior remains correct (margin reservation and release)', async () => {
    const futInitial = demoLedger.getBalance('FUTURES_USDT', userA);
    const futOrder = await futuresOrderService.placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '20000',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
      accountId: userA
    });

    // Margin = 20000 / 10 = 2000 locked
    expect(demoLedger.getBalance('FUTURES_USDT', userA)).toBe((Number(futInitial) - 2000).toString());

    await futuresOrderService.cancelOrder(futOrder.id);
    // 2000 refunded
    expect(demoLedger.getBalance('FUTURES_USDT', userA)).toBe(futInitial);
  });

  it('13. sessionStorage reload preserves the active session projection', () => {
    syncOrderToCore('ord-persist-1', userA, 'BTCUSDT', 'SPOT', 'BUY', 'LIMIT', '1', '50000', undefined, 'NEW');
    syncFillToCore('fill-persist-1', 'ord-persist-1', userA, 'BTCUSDT', 'SPOT', 'BUY', '1', '50000', '5', 'USDT');

    // Simulate new instance loading from sessionStorage
    const freshOrderCore = new (orderCoreService.constructor as any)(true);
    const freshTradeFill = new (tradeFillService.constructor as any)(true);

    expect(freshOrderCore.getOrder('ord-persist-1')).toBeDefined();
    expect(freshTradeFill.getFill('fill-persist-1')).toBeDefined();
  });

  it('14. Stale localStorage projection does not overwrite active sessionStorage', () => {
    sessionStorage.setItem('demo_core_orders', JSON.stringify([
      { id: 'session-order', userId: userA, symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT', quantity: '1', price: '50000', executedQuantity: '0', remainingQuantity: '1', averageFillPrice: '0', status: 'OPEN', fee: '0', createdAt: Date.now(), updatedAt: Date.now() }
    ]));

    localStorage.setItem('demo_core_orders', JSON.stringify([
      { id: 'stale-local-order', userId: 'old-user', symbol: 'ETHUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT', quantity: '10', price: '2000', executedQuantity: '0', remainingQuantity: '10', averageFillPrice: '0', status: 'OPEN', fee: '0', createdAt: Date.now() - 100000, updatedAt: Date.now() - 100000 }
    ]));

    const freshOrderCore = new (orderCoreService.constructor as any)(true);
    const orders = freshOrderCore.getOrders();

    expect(orders.length).toBe(1);
    expect(orders[0].id).toBe('session-order');
    expect(freshOrderCore.getOrder('stale-local-order')).toBeUndefined();
  });

  it('15. Reset/reinitialization does not leave stale projection state', async () => {
    await orderService.placeOrder({
      id: 'spot-reset-a',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    await orderService.placeOrder({
      id: 'spot-reset-b',
      accountId: userB,
      symbol: 'ETHUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '2000',
      quantity: '1.0',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    expect(orderCoreService.getOrders(userA).length).toBe(1);
    expect(orderCoreService.getOrders(userB).length).toBe(1);

    // Reset userA only
    orderService.reset(userA);

    expect(orderCoreService.getOrders(userA).length).toBe(0);
    expect(orderCoreService.getOrders(userB).length).toBe(1);

    // Reset all
    orderService.reset();
    expect(orderCoreService.getOrders().length).toBe(0);
  });

  it('16. accountId remains attached to every canonical order/fill', async () => {
    const spotOrder = await orderService.placeOrder({
      id: 'spot-account-id',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.2',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const futOrder = await futuresOrderService.placeOrder({
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '20000',
      quantity: '0.2',
      leverage: 5,
      marginMode: 'ISOLATED',
      accountId: userB
    });

    const spotCore = orderCoreService.getOrder(spotOrder.id);
    const futCore = orderCoreService.getOrder(futOrder.id);

    expect(spotCore?.userId).toBe(userA);
    expect(futCore?.userId).toBe(userB);
  });
});
