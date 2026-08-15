import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PortfolioService } from './PortfolioService';
import { DemoLedger } from './ledger';
import { TradeService } from './TradeService';
import { OrderService } from './OrderService';
import { Decimal } from 'decimal.js';

vi.mock('./marketData', () => ({
  fetchMarketData: vi.fn().mockResolvedValue([
    { baseAsset: 'BTC', price: 60000, priceStr: '60000', change24h: 10 }, // 10% up
    { baseAsset: 'ETH', price: 3000, priceStr: '3000', change24h: -10 }, // 10% down
  ])
}));

describe('PortfolioService (PNL and Valuation)', () => {
  let ledger: DemoLedger;
  let tradeSvc: TradeService;
  let orderSvc: OrderService;
  let portfolioSvc: PortfolioService;

  beforeEach(() => {
    ledger = new DemoLedger(false);
    tradeSvc = new TradeService(false);
    orderSvc = new OrderService(ledger, tradeSvc, false);
    portfolioSvc = new PortfolioService(ledger, orderSvc, tradeSvc);
    
    // Clear initial balances to start clean
    ledger.debit('USDT', '10000', 'clear');
  });

  it('should calculate initial valuation correctly', async () => {
    ledger.credit('USDT', '10000', 'initial');
    const stats = await portfolioSvc.getPortfolioStats('demo-account');
    
    expect(stats.totalValue).toBe('10000');
    expect(stats.totalRealizedPnl).toBe('0');
    expect(stats.totalUnrealizedPnl).toBe('0');
    
    const usdt = stats.assets.find(a => a.symbol === 'USDT');
    expect(usdt).toBeDefined();
    expect(usdt!.balance).toBe('10000');
  });

  it('should calculate cost basis and unrealized PNL on BUY', async () => {
    ledger.credit('USDT', '10000', 'initial');
    
    // Buy 0.1 BTC at 50,000 (Cost: 5000 USDT)
    // Market is currently 60,000, so Unrealized PNL = (60k - 50k) * 0.1 = 1000
    tradeSvc.recordTrade({
      orderId: '1', accountId: 'demo-account', symbol: 'BTCUSDT', side: 'BUY', price: '50000', quantity: '0.1'
    });
    
    // Simulate balance change
    ledger.debit('USDT', '5000', 'buy');
    ledger.credit('BTC', '0.1', 'buy');
    
    const stats = await portfolioSvc.getPortfolioStats('demo-account');
    expect(stats.totalValue).toBe('11000'); // 5000 USDT + (0.1 * 60000)
    expect(stats.totalUnrealizedPnl).toBe('1000');
    expect(stats.totalRealizedPnl).toBe('0');
    
    const btc = stats.assets.find(a => a.symbol === 'BTC')!;
    expect(btc.avgEntryPrice).toBe('50000');
    expect(btc.unrealizedPnl).toBe('1000');
  });

  it('should calculate realized PNL on SELL', async () => {
    ledger.credit('USDT', '10000', 'initial');
    
    // Buy 0.2 BTC at 50,000
    tradeSvc.recordTrade({
      orderId: '1', accountId: 'demo-account', symbol: 'BTCUSDT', side: 'BUY', price: '50000', quantity: '0.2'
    });
    ledger.debit('USDT', '10000', 'buy');
    ledger.credit('BTC', '0.2', 'buy');
    
    // Sell 0.1 BTC at 70,000
    // Realized PNL = (70k - 50k) * 0.1 = 2000
    tradeSvc.recordTrade({
      orderId: '2', accountId: 'demo-account', symbol: 'BTCUSDT', side: 'SELL', price: '70000', quantity: '0.1'
    });
    ledger.debit('BTC', '0.1', 'sell');
    ledger.credit('USDT', '7000', 'sell'); // 0.1 * 70000
    
    const stats = await portfolioSvc.getPortfolioStats('demo-account');
    
    // Remaining 0.1 BTC at market 60,000 = 6000
    // USDT balance = 7000
    // Total value = 13000
    // Unrealized = (60k - 50k) * 0.1 = 1000
    
    expect(stats.totalValue).toBe('13000');
    expect(stats.totalRealizedPnl).toBe('2000');
    expect(stats.totalUnrealizedPnl).toBe('1000');
  });

  it('should track locked funds in total balance', async () => {
    ledger.credit('USDT', '10000', 'initial');
    
    // Lock 4000 USDT in a pending order
    await orderSvc.placeOrder({
      id: 'ord-1', accountId: 'demo-account', symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '40000', quantity: '0.1', status: 'PENDING', createdAt: Date.now(), updatedAt: Date.now()
    });
    
    // Ledger shows 6000 available.
    expect(ledger.getBalance('USDT')).toBe('6000');
    
    const stats = await portfolioSvc.getPortfolioStats('demo-account');
    const usdt = stats.assets.find(a => a.symbol === 'USDT')!;
    
    expect(usdt.available).toBe('6000');
    expect(usdt.locked).toBe('4000');
    expect(usdt.balance).toBe('10000'); // total remains 10000
    expect(stats.totalValue).toBe('10000');
  });
});
