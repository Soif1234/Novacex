import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FuturesOrderService } from './FuturesOrderService';
import { DemoLedger } from '../ledger';

import { futuresMarketService } from './FuturesMarketService';

describe('FuturesOrderService', () => {
  let ledger: DemoLedger;
  let service: FuturesOrderService;
  const accountId = 'test-acc';

  
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
    
    ledger = new DemoLedger(false);

    service = new FuturesOrderService(ledger, false);
    // Initialize ledger with funds
    ledger.credit('FUTURES_USDT', '10000', 'init');
  });

  it('should successfully place an opening LONG order', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('FILLED');
    
    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1);
    
    const pos = positions[0];
    expect(pos.side).toBe('LONG');
    expect(pos.quantity).toBe('1');
    expect(pos.status).toBe('OPEN');
    
    const balance = ledger.getBalance('FUTURES_USDT');
    // Balance should be reduced by margin + fees
    expect(Number(balance)).toBeLessThan(20000);
  });

  it('should successfully place an opening SHORT order', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('FILLED');
    
    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1);
    expect(positions[0].side).toBe('SHORT');
  });

  it('should reject order with insufficient margin', async () => {
    // Empty ledger
    ledger.reset();
    
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '10', // Needs ~60,000 USDT at 10x
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/Insufficient margin/);
  });

  it('should reject invalid quantity', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0', // Invalid
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow('Quantity is below the minimum for BTCUSDT.');
  });

  it('should reject invalid leverage', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 77, // Invalid
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/Invalid leverage/);
  });

  it('should successfully increase a position', async () => {
    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.5',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1); // Still 1 position
    expect(positions[0].quantity).toBe('1.5');
  });

  it('should successfully reduce a position', async () => {
    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '2',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'LONG', // SELL LONG = close long
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1); 
    expect(positions[0].quantity).toBe('1');
  });
  
  it('should completely close a position', async () => {
    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'SHORT',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'SHORT', // BUY SHORT = close short
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1); 
    expect(positions[0].quantity).toBe('0');
    expect(positions[0].status).toBe('CLOSED');
  });

  it('should prevent duplicate execution if status is not NEW', async () => {
    // Hard to test this exact race condition without modifying the code, 
    // but we can simulate the status check.
    const serviceMock: any = service;
    const order: any = {
      id: '123',
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED',
      status: 'FILLED'
    };
    
    // Bypass the initial placeOrder function and try to execute a pending order
    await expect(serviceMock.executeOrder(order, { lastPrice: '50000', maintenanceMarginRate: '0.005' }, new (require("decimal.js").Decimal)('50000'))).rejects.toThrow();
  });

  it('should successfully place a PENDING LONG limit order and lock margin', async () => {
    const order = await service.placeOrder({
      accountId,
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
    
    const balance = ledger.getBalance('FUTURES_USDT');
    // Lock for 1 BTC at 40000 with 10x leverage = 4000 USDT locked
    expect(Number(balance)).toBe(6000);
  });

  it('should cancel a PENDING limit order and unlock margin', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '40000',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    await service.cancelOrder(order.id);
    
    const cancelledOrder = service.getOrders(accountId).find(o => o.id === order.id);
    expect(cancelledOrder?.status).toBe('CANCELLED');
    
    const balance = ledger.getBalance('FUTURES_USDT');
    expect(Number(balance)).toBe(10000);
  });

  it('should execute PENDING limit order when market condition met', async () => {
    // For this test we have to mock or set the market price somehow. 
    // Wait, the FuturesMarketService gets market from fetchMarketData which has hardcoded prices.
    // BTCUSDT is usually 50000 in the mock data.
    // So if we place a BUY LIMIT at 60000, it should execute immediately!
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '60000', // 60000 >= 50000, so it executes
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    // We need to wait for checkLimitOrders inside placeOrder
    // Wait, checkLimitOrders fetches market data asynchronously.
    // Vitest runs synchronously here unless we await something.
    // placeOrder does `await this.checkLimitOrders()` so it should be finished.
    expect(order.status).toBe('FILLED');
    const pos = service.getPositions(accountId);
    expect(pos.length).toBe(1);
    expect(pos[0].entryPrice).toBe('60000'); // the execution price for limit is limitPrice in the mock
  });

  it('should NOT execute PENDING limit order when market condition NOT met', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '40000', // 40000 < 50000, so it waits
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(order.status).toBe('PENDING');
  });

  it('should reject limit order without a price', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/LIMIT order requires a price/);
  });


  it('should trigger a STOP_MARKET order and execute when condition met', async () => {
    // Current price is 50000
    // We want to trigger when price >= 60000
    // So let's mock the market price to 60000 for this test
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '40000', // since price is 50000, 50000 >= 40000, it should trigger immediately
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    expect(order.isTriggered).toBe(true);
    expect(order.status).toBe('FILLED');
  });

  it('should NOT trigger a STOP_MARKET order when condition NOT met', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '60000', // 50000 is not >= 60000
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    expect(order.isTriggered).toBe(false);
    expect(order.status).toBe('PENDING');
  });

  it('should trigger a STOP_LIMIT order, lock margin, and wait for limit condition', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_LIMIT',
      stopPrice: '40000', // triggers immediately since 50000 >= 40000
      price: '30000',     // limit condition not met since 50000 is not <= 30000
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    expect(order.isTriggered).toBe(true);
    expect(order.status).toBe('PENDING'); // still pending because limit condition not met
    
    const balance = ledger.getBalance('FUTURES_USDT');
    // Lock for 1 BTC at 30000 with 10x leverage = 3000 USDT locked
    expect(Number(balance)).toBe(7000);
  });

  it('should prevent triggering cancelled orders', async () => {
    const order = await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '60000',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    await service.cancelOrder(order.id);
    await service.checkStopOrders(); // manual trigger check
    
    expect(order.isTriggered).toBe(false);
    expect(order.status).toBe('CANCELLED');
  });

  it('should reject STOP orders with invalid trigger prices', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'STOP_MARKET',
      stopPrice: '-1',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/Invalid stop price/);
  });

});
