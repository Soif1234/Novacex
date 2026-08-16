import { describe, it, expect, beforeEach } from 'vitest';
import { FuturesOrderService } from './FuturesOrderService';
import { DemoLedger } from '../ledger';
import { futuresMarketService } from './FuturesMarketService';
import Decimal from 'decimal.js';

describe('Futures Close Orders', () => {
  let ledger: DemoLedger;
  let service: FuturesOrderService;
  const accountId = 'test-acc';

  beforeEach(() => {
    ledger = new DemoLedger(false);
    ledger.reset();
    ledger.credit('FUTURES_USDT', '20000', 'Init');
    service = new FuturesOrderService(ledger, false);
    service.reset();
  });

  it('1 & 5. Full LONG limit close', async () => {
    // Open LONG
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
      type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    // Limit close
    const closeOrder = await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
      type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    expect(closeOrder.status).toBe('PENDING');
    expect(closeOrder.reduceOnly).toBe(true);
    
    // Check limit orders manually triggering it (market price mock is 50000, limit is 60000)
    // Wait, checkLimitOrders fetches 50000. 50000 >= 60000 is false.
    // If we want it to execute, we need to mock or change limit price.
    // Let's place a limit at 40000 so it executes immediately.
    const closeOrder2 = await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
      type: 'LIMIT', price: '60000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    expect(closeOrder2.status).toBe('FILLED');
    const pos = service.getPositions(accountId)[0];
    expect(pos.quantity).toBe('0');
    expect(pos.status).toBe('CLOSED');
  });

  it('3. Partial LONG close', async () => {
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
      type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
      type: 'LIMIT', price: '60000', quantity: '0.4', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    const pos = service.getPositions(accountId)[0];
    expect(pos.quantity).toBe('0.6');
    expect(pos.status).toBe('OPEN');
  });

  it('2 & 6. Full SHORT limit close', async () => {
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT',
      type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const closeOrder = await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'SHORT',
      type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    // 64230 <= 70000, executes immediately!
    expect(closeOrder.status).toBe('FILLED');
    const pos = service.getPositions(accountId)[0];
    expect(pos.quantity).toBe('0');
    expect(pos.status).toBe('CLOSED');
  });

  it('4. Partial SHORT close', async () => {
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'SHORT',
      type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'SHORT',
      type: 'LIMIT', price: '70000', quantity: '0.3', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    const pos = service.getPositions(accountId)[0];
    expect(pos.quantity).toBe('0.7');
    expect(pos.status).toBe('OPEN');
  });

  it('8. Prevent over-closing', async () => {
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
      type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    // Try to close 2 BTC when we only have 1
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
      type: 'MARKET', quantity: '2', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    const pos = service.getPositions(accountId)[0];
    expect(pos.quantity).toBe('0'); // It clamped it to 1, closed fully
    expect(pos.status).toBe('CLOSED');
    
    // No opposite SHORT position should exist
    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1); // Only the closed LONG position
  });

  it('9. Cancel pending close order', async () => {
    await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG',
      type: 'MARKET', quantity: '1', leverage: 10, marginMode: 'ISOLATED'
    });
    
    const closeOrder = await service.placeOrder({
      accountId, symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG',
      type: 'LIMIT', price: '70000', quantity: '1', leverage: 10, marginMode: 'ISOLATED',
      reduceOnly: true, closePosition: true
    });
    
    expect(closeOrder.status).toBe('PENDING');
    
    await service.cancelOrder(closeOrder.id);
    expect(closeOrder.status).toBe('CANCELLED');
    
    const pos = service.getPositions(accountId)[0];
    expect(pos.quantity).toBe('1'); // Unchanged
    expect(pos.status).toBe('OPEN');
  });

  it('Order history persistence check', async () => {
     const orders = service.getOrders(accountId);
     expect(orders.length).toBe(0);
  });
});
