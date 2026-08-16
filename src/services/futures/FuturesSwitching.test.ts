import { describe, it, expect, vi, beforeEach } from 'vitest';
import { futuresOrderService } from './FuturesOrderService';
import { DemoLedger, demoLedger } from '../ledger';

describe('Futures Multi-Pair Switching & Isolation', () => {
  beforeEach(() => {
    // Clear storage
    sessionStorage.clear();
    // @ts-ignore
    futuresOrderService.orders = [];
    // @ts-ignore
    futuresOrderService.positions = [];
    // @ts-ignore
    futuresOrderService.trades = [];
    
    // Add initial balance
    demoLedger.credit('FUTURES_USDT', '100000', 'init');
  });

  it('8. Position isolation & 19. Simultaneous BTC/ETH positions', async () => {
    await futuresOrderService.placeOrder({
      accountId: 'test-acc',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    await futuresOrderService.placeOrder({
      accountId: 'test-acc',
      symbol: 'ETHUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    const positions = futuresOrderService.getPositions('test-acc');
    expect(positions.length).toBe(2);
    
    const btcPos = positions.find(p => p.symbol === 'BTCUSDT');
    const ethPos = positions.find(p => p.symbol === 'ETHUSDT');
    
    expect(btcPos).toBeDefined();
    expect(ethPos).toBeDefined();
    
    expect(btcPos?.quantity).toBe('0.1');
    expect(ethPos?.quantity).toBe('1');
  });

  it('15. Minimum quantity validation', async () => {
    await expect(futuresOrderService.placeOrder({
      accountId: 'test-acc',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.000001', // Too small
      leverage: 10,
      marginMode: 'ISOLATED'
    })).rejects.toThrow('Quantity is below the minimum for BTCUSDT.');
  });
});
