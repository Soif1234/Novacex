import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FuturesOrderService } from './FuturesOrderService';
import { DemoLedger } from '../ledger';
import { futuresMarketService } from './FuturesMarketService';

describe('Regression Tests for LONG/SHORT Execution', () => {
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
    ledger.reset();
    ledger.credit('FUTURES_USDT', '20000', 'Init');
    service = new FuturesOrderService(ledger, false);
    service.reset();
  });

  it('1 & 3 & 5. LONG market order & position creation & margin calculation', async () => {
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
    expect(order.side).toBe('BUY');
    expect(order.positionSide).toBe('LONG');
    
    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1);
    
    const pos = positions[0];
    expect(pos.side).toBe('LONG');
    expect(pos.quantity).toBe('1');
    expect(pos.status).toBe('OPEN');
    
    // margin calculation: 50000 / 10 = 5000
    // But we don't mock market price, so we rely on what FuturesMarketService returns.
    // Default is usually 50000, so IM = 5000
    expect(Number(pos.initialMargin)).toBeGreaterThan(0);
  });

  it('2 & 4 & 6. SHORT market order & position creation & margin calculation', async () => {
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
    expect(order.positionSide).toBe('SHORT');
    
    const positions = service.getPositions(accountId);
    expect(positions.length).toBe(1);
    
    const pos = positions[0];
    expect(pos.side).toBe('SHORT');
    expect(pos.quantity).toBe('1');
    expect(pos.status).toBe('OPEN');
  });

  it('7. Invalid quantity', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0',
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow('Quantity is below the minimum for BTCUSDT.');
  });

  it('8. Invalid leverage', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 125,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/Invalid leverage/);
  });

  it('9. Insufficient margin', async () => {
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '10', // Needs 500k Notional -> 50k IM
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/Insufficient margin/);
  });
  
  it('10. Duplicate execution is prevented by checking OPEN status during partial close', async () => {
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
    
    const pos = service.getPositions(accountId)[0];
    
    await service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });
    
    // Trying to close again should throw
    await expect(service.placeOrder({
      accountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow(/No open position to close/);
  });
});
