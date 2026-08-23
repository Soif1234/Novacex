import { describe, it, expect } from 'vitest';
import { FuturesPositionService } from './FuturesPositionService';
import { FuturesPosition, PositionSide, MarginMode } from '../../types/futures';

describe.skip('FuturesPositionService', () => {
  const service = new FuturesPositionService();

  describe.skip('calculateUnrealizedPnl', () => {
    it('should calculate positive PNL for LONG when price increases', () => {
      // LONG 1 BTC at 50,000. Price increases to 55,000. PNL = (55000 - 50000) * 1 = 5000
      expect(service.calculateUnrealizedPnl('LONG', '1', '50000', '55000')).toBe('5000');
    });

    it('should calculate negative PNL for LONG when price decreases', () => {
      // LONG 1 BTC at 50,000. Price decreases to 48,000. PNL = (48000 - 50000) * 1 = -2000
      expect(service.calculateUnrealizedPnl('LONG', '1', '50000', '48000')).toBe('-2000');
    });

    it('should calculate positive PNL for SHORT when price decreases', () => {
      // SHORT 1 BTC at 50,000. Price decreases to 45,000. PNL = (50000 - 45000) * 1 = 5000
      expect(service.calculateUnrealizedPnl('SHORT', '1', '50000', '45000')).toBe('5000');
    });

    it('should calculate negative PNL for SHORT when price increases', () => {
      // SHORT 1 BTC at 50,000. Price increases to 52,000. PNL = (50000 - 52000) * 1 = -2000
      expect(service.calculateUnrealizedPnl('SHORT', '1', '50000', '52000')).toBe('-2000');
    });

    it('should return 0 when quantity is 0', () => {
      expect(service.calculateUnrealizedPnl('LONG', '0', '50000', '55000')).toBe('0');
      expect(service.calculateUnrealizedPnl('SHORT', '0', '50000', '45000')).toBe('0');
    });
  });

  describe.skip('calculateRealizedPnl', () => {
    it('should calculate correctly for LONG', () => {
      expect(service.calculateRealizedPnl('LONG', '0.5', '50000', '60000')).toBe('5000'); // (60000 - 50000) * 0.5 = 5000
      expect(service.calculateRealizedPnl('LONG', '1', '50000', '40000')).toBe('-10000');
    });

    it('should calculate correctly for SHORT', () => {
      expect(service.calculateRealizedPnl('SHORT', '0.5', '50000', '40000')).toBe('5000'); // (50000 - 40000) * 0.5 = 5000
      expect(service.calculateRealizedPnl('SHORT', '1', '50000', '60000')).toBe('-10000');
    });
  });

  describe.skip('createPosition', () => {
    it('should create a new position with correct initial values', () => {
      const position = service.createPosition({
        accountId: 'acc1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '2',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005'
      });

      expect(position.positionId).toBeDefined();
      expect(position.accountId).toBe('acc1');
      expect(position.symbol).toBe('BTCUSDT');
      expect(position.side).toBe('LONG');
      expect(position.quantity).toBe('2');
      expect(position.entryPrice).toBe('50000');
      expect(position.markPrice).toBe('50000');
      expect(position.leverage).toBe(10);
      expect(position.marginMode).toBe('ISOLATED');
      
      // Initial margin = (2 * 50000) / 10 = 10000
      expect(position.initialMargin).toBe('10000');
      
      // Maintenance margin = (2 * 50000) * 0.005 = 500
      expect(position.maintenanceMargin).toBe('500');
      
      expect(position.unrealizedPnl).toBe('0');
      expect(position.realizedPnl).toBe('0');
      expect(position.status).toBe('OPEN');
    });
  });

  describe.skip('increasePosition', () => {
    it('should recalculate entry price and margins', () => {
      const pos1 = service.createPosition({
        accountId: 'acc1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '1',
        entryPrice: '40000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005'
      });

      const pos2 = service.increasePosition(pos1, '1', '50000', '0.005');

      expect(pos2.quantity).toBe('2');
      // Weighted average entry = ((1*40000) + (1*50000)) / 2 = 45000
      expect(pos2.entryPrice).toBe('45000');
      expect(pos2.markPrice).toBe('50000');
      
      // New Initial Margin = (2 * 45000) / 10 = 9000
      expect(pos2.initialMargin).toBe('9000');
      // New MM = 90000 * 0.005 = 450
      expect(pos2.maintenanceMargin).toBe('450');
    });
  });

  describe.skip('reducePosition', () => {
    it('should reduce quantity and calculate realized PNL', () => {
      const pos1 = service.createPosition({
        accountId: 'acc1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '2',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005'
      });

      // Reduce by 1 BTC at 60000
      const { updatedPosition, realizedPnl } = service.reducePosition(pos1, '1', '60000', '0.005');

      expect(updatedPosition.quantity).toBe('1');
      expect(updatedPosition.entryPrice).toBe('50000'); // entry price doesn't change on reduction
      expect(updatedPosition.markPrice).toBe('60000');
      
      // Realized PNL = (60000 - 50000) * 1 = 10000
      expect(realizedPnl).toBe('10000');
      expect(updatedPosition.realizedPnl).toBe('10000');
      
      // New Initial Margin = (1 * 50000) / 10 = 5000
      expect(updatedPosition.initialMargin).toBe('5000');
      expect(updatedPosition.status).toBe('OPEN');
    });

    it('should close position if quantity is reduced to 0', () => {
      const pos1 = service.createPosition({
        accountId: 'acc1',
        symbol: 'BTCUSDT',
        side: 'SHORT',
        quantity: '2',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005'
      });

      // Reduce by 2 BTC at 40000
      const { updatedPosition, realizedPnl } = service.reducePosition(pos1, '2', '40000', '0.005');

      expect(updatedPosition.quantity).toBe('0');
      expect(updatedPosition.entryPrice).toBe('50000');
      
      // Realized PNL for SHORT = (50000 - 40000) * 2 = 20000
      expect(realizedPnl).toBe('20000');
      expect(updatedPosition.realizedPnl).toBe('20000');
      expect(updatedPosition.initialMargin).toBe('0');
      expect(updatedPosition.status).toBe('CLOSED');
    });

    it('should cap reduction to current quantity', () => {
      const pos1 = service.createPosition({
        accountId: 'acc1',
        symbol: 'BTCUSDT',
        side: 'LONG',
        quantity: '1',
        entryPrice: '50000',
        leverage: 10,
        marginMode: 'ISOLATED',
        maintenanceMarginRate: '0.005'
      });

      // Try to reduce by 5 BTC, should cap at 1 BTC
      const { updatedPosition, realizedPnl } = service.reducePosition(pos1, '5', '60000', '0.005');

      expect(updatedPosition.quantity).toBe('0');
      expect(realizedPnl).toBe('10000');
      expect(updatedPosition.status).toBe('CLOSED');
    });
  });

  describe.skip('calculatePositionNotional', () => {
    it('should calculate notional via risk service', () => {
      expect(service.calculatePositionNotional('2', '50000')).toBe('100000');
    });
  });
});
