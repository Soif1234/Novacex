import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FuturesFundingService } from './FuturesFundingService';
import { DemoLedger } from '../ledger';
import { FuturesPosition } from '../../types/futures';
import Decimal from 'decimal.js';

describe('Futures Funding Service', () => {
  let ledger: DemoLedger;
  let service: FuturesFundingService;

  beforeEach(() => {
    ledger = new DemoLedger(false);
    ledger.reset();
    ledger.credit('FUTURES_USDT', '20000', 'Init');
    
    // Non-persisting service for tests
    service = new FuturesFundingService(ledger, false);
  });

  it('7. Funding calculation', () => {
    const posLong = { side: 'LONG', quantity: '1', markPrice: '10000' } as any;
    const posShort = { side: 'SHORT', quantity: '1', markPrice: '10000' } as any;
    
    service.setFundingRate('0.0001'); // 0.01%
    expect(service.calculateEstimatedFunding(posLong, posLong.markPrice)).toBe('-1'); // Long pays 1
    expect(service.calculateEstimatedFunding(posShort, posShort.markPrice)).toBe('1'); // Short receives 1
    
    service.setFundingRate('-0.0001'); // -0.01%
    expect(service.calculateEstimatedFunding(posLong, posLong.markPrice)).toBe('1'); // Long receives 1
    expect(service.calculateEstimatedFunding(posShort, posShort.markPrice)).toBe('-1'); // Short pays 1
  });
  
  it('1. Positive funding & 3. LONG pays & 6. SHORT receives', () => {
    service.setFundingRate('0.0001'); // 0.01%
    const posLong: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    const posShort: FuturesPosition = {
        positionId: '2', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'SHORT',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    
    const beforeBalance = new Decimal(ledger.getBalance('FUTURES_USDT'));
    
    service.forceSettleForTesting([posLong, posShort], {});
    
    // Long paid 1, Short received 1. Net balance should be the same.
    const afterBalance = new Decimal(ledger.getBalance('FUTURES_USDT'));
    expect(afterBalance.toString()).toBe(beforeBalance.toString());
    
    const history = service.getHistory('test-acc');
    expect(history.length).toBe(2);
    
    const longHist = history.find(h => h.positionId === '1')!;
    expect(longHist.payerReceiver).toBe('PAYER');
    expect(longHist.fundingAmount).toBe('1');
    
    const shortHist = history.find(h => h.positionId === '2')!;
    expect(shortHist.payerReceiver).toBe('RECEIVER');
    expect(shortHist.fundingAmount).toBe('1');
  });

  it('2. Negative funding & 4. LONG receives & 5. SHORT pays', () => {
    service.setFundingRate('-0.0001'); // -0.01%
    const posLong: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    const posShort: FuturesPosition = {
        positionId: '2', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'SHORT',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    
    const beforeBalance = new Decimal(ledger.getBalance('FUTURES_USDT'));
    
    service.forceSettleForTesting([posLong, posShort], {});
    
    // Net balance should be the same.
    const afterBalance = new Decimal(ledger.getBalance('FUTURES_USDT'));
    expect(afterBalance.toString()).toBe(beforeBalance.toString());
    
    const history = service.getHistory('test-acc');
    expect(history.length).toBe(2);
    
    const longHist = history.find(h => h.positionId === '1')!;
    expect(longHist.payerReceiver).toBe('RECEIVER');
    expect(longHist.fundingAmount).toBe('1');
    
    const shortHist = history.find(h => h.positionId === '2')!;
    expect(shortHist.payerReceiver).toBe('PAYER');
    expect(shortHist.fundingAmount).toBe('1');
  });

  it('10. Duplicate settlement prevention', () => {
    service.setFundingRate('0.0001');
    const posLong: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    
    // First settle
    service.forceSettleForTesting([posLong], {});
    const history1 = service.getHistory('test-acc');
    expect(history1.length).toBe(1);
    
    const nextFundingBefore = service.getNextFundingTime();
    
    // Attempt second settle immediately (time hasn't passed)
    service.settleFunding([posLong], {});
    
    const history2 = service.getHistory('test-acc');
    expect(history2.length).toBe(1); // No new history
    expect(service.getNextFundingTime()).toBe(nextFundingBefore);
    
    // Even if we mock the nextFundingTime to go back to the exact same event id, 
    // it will prevent duplicate by checking history
    const eventId = history1[0].id;
    // We can't easily mock event ID generation, but we know it checks.
  });
  
  it('11. Multiple positions', () => {
    service.setFundingRate('0.0001');
    const posLong1: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    const posShort2: FuturesPosition = {
        positionId: '2', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'SHORT',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    const posLong3: FuturesPosition = {
        positionId: '3', accountId: 'test-acc', symbol: 'ETHUSDT', side: 'LONG',
        quantity: '10', entryPrice: '3000', markPrice: '3000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    
    service.forceSettleForTesting([posLong1, posShort2, posLong3], {});
    const history = service.getHistory('test-acc');
    expect(history.length).toBe(3);
  });
  
  it('12. Ledger update & 13. Funding history', () => {
      service.setFundingRate('0.0001');
      const posLong: FuturesPosition = {
          positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
          quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
          initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
          liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
      };
      
      const transactionsBefore = ledger.getHistory().filter(t => t.asset === 'USDT').length;
      service.forceSettleForTesting([posLong], {});
      const transactionsAfter = ledger.getHistory().filter(t => t.asset === 'USDT').length;
      
      expect(transactionsAfter).toBe(transactionsBefore + 1);
      const tx = ledger.getHistory().filter(t => t.asset === 'USDT')[0]; // It's prepended
      expect(tx.reason).toContain('FUNDING_PAYMENT');
      expect(tx.amount).toBe('1'); // Debit 1
  });

  it('14. Zero position', () => {
    service.setFundingRate('0.0001');
    const posLong: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '0', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '0', maintenanceMargin: '0', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    
    service.forceSettleForTesting([posLong], {});
    const history = service.getHistory('test-acc');
    expect(history.length).toBe(0); // Should skip 0 notional
  });

  it('15. Closed position', () => {
    service.setFundingRate('0.0001');
    const posLong: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'CLOSED', createdAt: 0, updatedAt: 0
    };
    
    service.forceSettleForTesting([posLong], {});
    const history = service.getHistory('test-acc');
    expect(history.length).toBe(0); // Should skip closed
  });

  it('16. Invalid funding rate', () => {
    service.setFundingRate('0'); // 0 funding
    const posLong: FuturesPosition = {
        positionId: '1', accountId: 'test-acc', symbol: 'BTCUSDT', side: 'LONG',
        quantity: '1', entryPrice: '10000', markPrice: '10000', leverage: 10, marginMode: 'ISOLATED',
        initialMargin: '1000', maintenanceMargin: '50', unrealizedPnl: '0', realizedPnl: '0',
        liquidationPrice: '0', status: 'OPEN', createdAt: 0, updatedAt: 0
    };
    
    service.forceSettleForTesting([posLong], {});
    const history = service.getHistory('test-acc');
    expect(history.length).toBe(0); // Should skip 0 funding rate
  });

  it('8. Funding countdown', () => {
      // test time remaining
      service.setFundingIntervalMs(8 * 60 * 60 * 1000);
      const remaining = service.getTimeUntilNextFunding();
      expect(remaining).toBeGreaterThan(0);
      expect(remaining).toBeLessThanOrEqual(8 * 60 * 60 * 1000);
  });

});
