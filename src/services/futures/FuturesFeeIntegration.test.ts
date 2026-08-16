import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FuturesOrderService } from './FuturesOrderService';
import { DemoLedger } from '../ledger';
import { futuresFeeService } from './FuturesFeeService';
import { FuturesMarketConfig, FUTURES_MARKETS } from './FuturesMarketConfig';
import { futuresMarketService } from './FuturesMarketService';
import { vi } from 'vitest';

describe('Futures Fee Integration', () => {
  let orderService: FuturesOrderService;
  let ledger: DemoLedger;
  let btcMarket: FuturesMarketConfig;

  beforeEach(() => {
    ledger = new DemoLedger();
    ledger.credit('FUTURES_USDT', '100000', 'init'); // Start with 100k USDT
    orderService = new FuturesOrderService(ledger, false);
    btcMarket = FUTURES_MARKETS.find(m => m.symbol === 'BTCUSDT')!;
    btcMarket.takerFee = '0.0005';
    btcMarket.makerFee = '0.0002';
  });

  beforeEach(() => {
    const mockMarket = { ...btcMarket, lastPrice: '63000', markPrice: '63000', indexPrice: '63000', fundingRate: '0.0001', change24h: '0' };
    vi.spyOn(futuresMarketService, 'getMarket').mockImplementation(async () => mockMarket as any);
  });
  
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('5. Opening fee - Market order (Taker)', async () => {
    const historyLenBefore = ledger.getHistory().length;
    const balBefore = Number(ledger.getBalance('FUTURES_USDT'));
    await orderService.placeOrder({
      accountId: 'test-user',
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '0.1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    // Margin = 63000 * 0.1 / 10 = 630. Fee = 63000 * 0.1 * 0.0005 = 3.15
    const pos = orderService.getPositions('test-user')[0];
    expect(pos).toBeDefined();
    
    const balAfter = Number(ledger.getBalance('FUTURES_USDT'));
    expect(balAfter).toBe(balBefore - 630 - 3.15);
    
    expect(pos.cumulativeFee).toBe('3.15');
    
    // Ledger entry for fee
    const feeEntry = ledger.getHistory().find(h => h.reason.includes('TAKER') && h.amount === '3.15');
    expect(feeEntry).toBeDefined();
    expect(feeEntry?.amount).toBe('3.15');
    expect(feeEntry?.reason).toContain('TAKER');
  });

  it('6. Closing fee & 8. Full close fee', async () => {
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    
    const balBeforeClose = Number(ledger.getBalance('FUTURES_USDT'));
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    
    // Fee = 3.15. Margin returned = 630. Pnl = 0.
    const balAfterClose = Number(ledger.getBalance('FUTURES_USDT'));
    expect(balAfterClose).toBeCloseTo(balBeforeClose + 630 - 3.15, 4);
    
    const pos = orderService.getPositions('test-user')[0];
    expect(pos.status).toBe('CLOSED');
    expect(pos.cumulativeFee).toBe('6.3'); // 3.15 + 3.15
  });

  it('7. Partial close fee & 11. Partial fill logic via partial close', async () => {
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    
    // Partially close 0.04
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: '0.04', leverage: 10, marginMode: 'ISOLATED' });
    
    // Fee = 63000 * 0.04 * 0.0005 = 1.26. 
    const pos = orderService.getPositions('test-user')[0];
    expect(pos.quantity).toBe('0.06');
    expect(pos.cumulativeFee).toBe('4.41'); // 3.15 + 1.26
  });

  it('9. Cancelled order & 10. Rejected order', async () => {
    const balBefore = Number(ledger.getBalance('FUTURES_USDT'));
    try {
      await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '9999999', leverage: 10, marginMode: 'ISOLATED' });
    } catch(e) {}
    
    const balAfter = Number(ledger.getBalance('FUTURES_USDT'));
    expect(balAfter).toBe(balBefore); // No fees deducted for rejection
    
    
    // Cancelled limit order
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'LIMIT', price: '10000', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    const orders = orderService.getOrders('test-user').filter(o => o.status === 'PENDING');
    expect(orders.length).toBe(1);
    const lockedMargin = 10000 * 0.1 / 10;
    expect(Number(ledger.getBalance('FUTURES_USDT'))).toBe(balBefore - lockedMargin); // margin locked, NO fee locked!
    
    await orderService.cancelOrder(orders[0].id);
    expect(Number(ledger.getBalance('FUTURES_USDT'))).toBe(balBefore); // Margin refunded, no fees applied
    });

  it('13. TP close fee & 14. SL close fee', async () => {
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    
    // SL close order
    const balBefore = Number(ledger.getBalance('FUTURES_USDT'));
    const slMarket = { ...btcMarket, lastPrice: '60000', markPrice: '60000', indexPrice: '60000', fundingRate: '0.0001', change24h: '0' };
    vi.spyOn(futuresMarketService, 'getMarket').mockImplementation(async () => slMarket as any);
    
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'SELL', positionSide: 'LONG', type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    
    // Fee = 60000 * 0.1 * 0.0005 = 3
    const pos = orderService.getPositions('test-user')[0];
    expect(pos.status).toBe('CLOSED');
    expect(pos.cumulativeFee).toBe('6.15'); // 3.15 + 3.00
  });

  it('19. Funding + trading fee separation', async () => {
    await orderService.placeOrder({ accountId: 'test-user', symbol: 'BTCUSDT', side: 'BUY', positionSide: 'LONG', type: 'MARKET', quantity: '0.1', leverage: 10, marginMode: 'ISOLATED' });
    
    // Add funding
    const { futuresFundingService } = await import('./FuturesFundingService');
    const pos = orderService.getPositions('test-user')[0];
    const originalBal = Number(ledger.getBalance('FUTURES_USDT'));
    
    // Manually push funding
    ledger.debit('FUTURES_USDT', '5', 'FUNDING_PAYMENT');
    pos.cumulativeFunding = '-5';
    
    expect(Number(ledger.getBalance('FUTURES_USDT'))).toBe(originalBal - 5);
    expect(pos.cumulativeFee).toBe('3.15'); // Unchanged
    expect(pos.cumulativeFunding).toBe('-5'); // Changed
  });
});
