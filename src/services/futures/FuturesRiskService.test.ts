import { describe, it, expect } from 'vitest';
import { FuturesRiskService } from './FuturesRiskService';
import { FuturesPosition, FuturesMarket } from '../../types/futures';

describe.skip('FuturesRiskService', () => {
  const service = new FuturesRiskService();

  const createPos = (overrides: Partial<FuturesPosition>): FuturesPosition => ({
    positionId: 'pos-1',
    accountId: 'acc-1',
    symbol: 'BTCUSDT',
    side: 'LONG',
    quantity: '1',
    entryPrice: '50000',
    markPrice: '50000',
    leverage: 10,
    marginMode: 'ISOLATED',
    initialMargin: '5000',
    maintenanceMargin: '250',
    unrealizedPnl: '0',
    realizedPnl: '0',
    liquidationPrice: '0',
    status: 'OPEN',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides
  });

  describe.skip('calculateNotional', () => {
    it('17. should return 0 for zero quantity or invalid price', () => {
      expect(service.calculateNotional('0', '50000')).toBe('0');
      expect(service.calculateNotional('10', '0')).toBe('0');
      expect(service.calculateNotional('-10', '50000')).toBe('0');
      expect(service.calculateNotional('10', '-50000')).toBe('0');
    });
    
    it('18. should return 0 for invalid quantity', () => {
      expect(service.calculateNotional('', '50000')).toBe('0');
    });
  });

  describe.skip('calculateMaintenanceMargin', () => {
    it('13. should calculate maintenance margin correctly', () => {
      expect(service.calculateMaintenanceMargin('1', '50000', '0.005')).toBe('250');
    });
  });

  describe.skip('Margin Ratio', () => {
    it('14. should calculate margin ratio correctly', () => {
      expect(service.calculateMarginRatio('250', '5000')).toBe('0.05');
      expect(service.calculateMarginRatio('250', '250')).toBe('1');
    });

    it('15. should handle zero equity safely', () => {
      expect(service.calculateMarginRatio('250', '0')).toBe('1');
    });

    it('16. should handle negative equity safely', () => {
      expect(service.calculateMarginRatio('250', '-100')).toBe('1');
    });
  });

  describe.skip('Liquidation Price', () => {
    it('1. should calculate LONG liquidation price (Isolated)', () => {
      // EP = 50000, IM = 5000, MM = 250, Q = 1
      // LP = 50000 + (250 - 5000)/1 = 45250
      const pos = createPos({});
      expect(service.calculateLiquidationPrice(pos, '0.005')).toBe('45250');
    });

    it('2. should calculate SHORT liquidation price (Isolated)', () => {
      // EP = 50000, IM = 5000, MM = 250, Q = 1
      // LP = 50000 + (5000 - 250)/1 = 54750
      const pos = createPos({ side: 'SHORT' });
      expect(service.calculateLiquidationPrice(pos, '0.005')).toBe('54750');
    });
  });

  describe.skip('Liquidation Condition', () => {
    it('3. should check LONG liquidation condition', () => {
      const posSafe = createPos({ unrealizedPnl: '0' });
      expect(service.checkLiquidation(posSafe)).toBe(false);

      const posLiq = createPos({ unrealizedPnl: '-4800' });
      // Equity = 5000 - 4800 = 200, MM = 250, so Liq = true
      expect(service.checkLiquidation(posLiq)).toBe(true);
    });

    it('4. should check SHORT liquidation condition', () => {
      const posSafe = createPos({ side: 'SHORT', unrealizedPnl: '-4000' });
      // Equity = 5000 - 4000 = 1000 > 250
      expect(service.checkLiquidation(posSafe)).toBe(false);

      const posLiq = createPos({ side: 'SHORT', unrealizedPnl: '-4800' });
      expect(service.checkLiquidation(posLiq)).toBe(true);
    });
    
    it('10. should isolate positions for liquidation', () => {
       const pos = createPos({ unrealizedPnl: '-4800' });
       // Check with available margin = 100000
       // If ISOLATED, availableMargin is ignored. Equity = 5000 - 4800 = 200.
       expect(service.checkLiquidation(pos, '100000')).toBe(true);
    });
    
    it('11. should use cross-margin risk correctly', () => {
       const pos = createPos({ marginMode: 'CROSS', unrealizedPnl: '-4800' });
       // With CROSS, available margin = 10000. Equity = 10000 + 5000 - 4800 = 10200 > 250
       expect(service.checkLiquidation(pos, '10000')).toBe(false);
       
       // If available margin = 0. Equity = 5000 - 4800 = 200 < 250
       expect(service.checkLiquidation(pos, '0')).toBe(true);
    });
  });

  describe.skip('Risk UI states', () => {
    it('5. should mark safe position', () => {
      expect(service.getRiskStatus('0.5')).toBe('SAFE');
    });

    it('6. should mark warning position', () => {
      expect(service.getRiskStatus('0.6')).toBe('WARNING');
      expect(service.getRiskStatus('0.89')).toBe('WARNING');
    });

    it('7. should mark liquidation-risk position', () => {
      expect(service.getRiskStatus('0.9')).toBe('LIQUIDATION_RISK');
      expect(service.getRiskStatus('1.5')).toBe('LIQUIDATION_RISK');
    });
  });
});
