import { describe, it, expect } from 'vitest';
import { FuturesService } from './FuturesService';
import { Decimal } from 'decimal.js';

describe('FuturesService', () => {
  it('should calculate initial margin correctly', () => {
    // Size: 1 BTC, Price: 50,000, Leverage: 10
    // Margin = (1 * 50,000) / 10 = 5,000
    const margin = FuturesService.calculateMargin('1', '50000', 10);
    expect(margin).toBe('5000');
  });

  it('should calculate long liquidation price correctly', () => {
    // Long 1 BTC at 50,000, 10x leverage. MMR = 0.5%
    // Liq = Entry * (1 - 1/Lev + MMR)
    // Liq = 50000 * (1 - 0.1 + 0.005) = 50000 * 0.905 = 45250
    const liq = FuturesService.calculateLiquidationPrice('LONG', '50000', 10);
    expect(liq).toBe('45250');
  });

  it('should calculate short liquidation price correctly', () => {
    // Short 1 BTC at 50,000, 10x leverage. MMR = 0.5%
    // Liq = Entry * (1 + 1/Lev - MMR)
    // Liq = 50000 * (1 + 0.1 - 0.005) = 50000 * 1.095 = 54750
    const liq = FuturesService.calculateLiquidationPrice('SHORT', '50000', 10);
    expect(liq).toBe('54750');
  });

  it('should calculate live stats for profitable long', () => {
    const pos = {
      id: '1', accountId: 'acc', symbol: 'BTCUSDT', side: 'LONG' as const,
      leverage: 10, size: '1', entryPrice: '50000', margin: '5000', liquidationPrice: '45250'
    };
    
    // Mark price up to 55,000
    // PNL = (55000 - 50000) * 1 = 5000
    // PNL % = 5000 / 5000 * 100 = 100%
    const stats = FuturesService.calculateLiveStats(pos, '55000');
    expect(stats.unrealizedPnl).toBe('5000');
    expect(stats.pnlPercentage).toBe('100');
  });

  it('should calculate live stats for unprofitable long', () => {
    const pos = {
      id: '1', accountId: 'acc', symbol: 'BTCUSDT', side: 'LONG' as const,
      leverage: 10, size: '1', entryPrice: '50000', margin: '5000', liquidationPrice: '45250'
    };
    
    // Mark price down to 48,000
    // PNL = (48000 - 50000) * 1 = -2000
    // PNL % = -2000 / 5000 * 100 = -40%
    const stats = FuturesService.calculateLiveStats(pos, '48000');
    expect(stats.unrealizedPnl).toBe('-2000');
    expect(stats.pnlPercentage).toBe('-40');
  });

  it('should calculate live stats for profitable short', () => {
    const pos = {
      id: '1', accountId: 'acc', symbol: 'BTCUSDT', side: 'SHORT' as const,
      leverage: 10, size: '1', entryPrice: '50000', margin: '5000', liquidationPrice: '54750'
    };
    
    // Mark price down to 45,000
    // PNL = (50000 - 45000) * 1 = 5000
    const stats = FuturesService.calculateLiveStats(pos, '45000');
    expect(stats.unrealizedPnl).toBe('5000');
    expect(stats.pnlPercentage).toBe('100');
  });

  it('should calculate live stats for unprofitable short', () => {
    const pos = {
      id: '1', accountId: 'acc', symbol: 'BTCUSDT', side: 'SHORT' as const,
      leverage: 10, size: '1', entryPrice: '50000', margin: '5000', liquidationPrice: '54750'
    };
    
    // Mark price up to 52,000
    // PNL = (50000 - 52000) * 1 = -2000
    const stats = FuturesService.calculateLiveStats(pos, '52000');
    expect(stats.unrealizedPnl).toBe('-2000');
    expect(stats.pnlPercentage).toBe('-40');
  });

  it('should manage opening and closing positions', async () => {
    const { demoLedger } = await import('./ledger');
    demoLedger.reset();
    demoLedger.credit('USDT', '100000', 'init');
    const svc = new FuturesService(demoLedger, false); // in-memory
    const pos = await svc.openPosition('acc-1', 'BTCUSDT', 'LONG', 10, '1');
    
    expect(svc.getPositions('acc-1').length).toBe(1);
    expect(Number(pos.margin)).toBeGreaterThan(0);
    
    // Close position
    const closeResult = await svc.closePosition(pos.id);
    expect(svc.getPositions('acc-1').length).toBe(0);
    expect(closeResult).not.toBeNull();
  });
});
