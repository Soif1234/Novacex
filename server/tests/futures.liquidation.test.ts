import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { FuturesLiquidationService } from '../src/services/futures/liquidation.service';
import { FuturesPositionService, futuresPositionService } from '../src/services/futures/position.service';
import { FuturesRiskService, futuresRiskService } from '../src/services/futures/risk.service';
import { ledgerService, LedgerService } from '../src/services/ledger/ledger.service';
import { DatabasePool } from '../src/config/database';
import { developmentMarkPriceProvider } from '../src/services/futures/mark-price.provider';
import crypto from 'crypto';
import { decimalCompare } from '../src/services/ledger/decimal';

describe('Phase 6.4A: Partial Liquidation Iterative Escalation', () => {
  let liquidationSvc: FuturesLiquidationService;
  let database: DatabasePool;
  
  beforeEach(async () => {
    database = new DatabasePool();
    await database.connect();
    
    // Setup insurance fund account
    await database.query(`INSERT INTO accounts (id, user_id, type) VALUES ('11111111-1111-1111-1111-111111111111', '00000000-0000-0000-0000-000000000000', 'SYSTEM_VAULT') ON CONFLICT DO NOTHING`);
    
    // Fund the insurance vault
    const testLedger = new LedgerService(database);
    await testLedger.postTransaction({
        accountId: '11111111-1111-1111-1111-111111111111',
        transactionType: 'DEPOSIT',
        referenceId: 'init-vault',
        entries: [
            { accountId: '11111111-1111-1111-1111-111111111111', asset: 'FUTURES_USDT', amount: '1000000', direction: 'CREDIT', balancePool: 'available' }
        ]
    });
    
    liquidationSvc = new FuturesLiquidationService(
      database,
      futuresRiskService,
      new FuturesPositionService(database, futuresRiskService),
      new LedgerService(database),
      developmentMarkPriceProvider
    );
  });
  
  const setupUserAndDeposit = async (amount: string = '10000') => {
      const userId = crypto.randomUUID();
      const accountId = crypto.randomUUID();
      await database.query('INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)', [accountId, userId, 'FUTURES']);
      
      const testLedger = new LedgerService(database);
      await testLedger.postTransaction({
          accountId,
          transactionType: 'DEPOSIT',
          referenceId: `init-${crypto.randomUUID()}`,
          entries: [
              { accountId, asset: 'FUTURES_USDT', amount, direction: 'CREDIT', balancePool: 'available' }
          ]
      });
      return { userId, accountId };
  };

  const createOpenPosition = async (
      accountId: string, 
      side: 'LONG' | 'SHORT', 
      marginMode: 'CROSS' | 'ISOLATED', 
      qty: string, 
      entryPrice: string, 
      leverage: number,
      lockedMargin: string
  ) => {
      const posId = crypto.randomUUID();
      const initialMargin = lockedMargin;
      const mm = futuresRiskService.calculateMaintenanceMargin(qty, entryPrice, '0.005');
      const lp = side === 'LONG' 
        ? (marginMode === 'ISOLATED' ? '45000' : '40000') 
        : (marginMode === 'ISOLATED' ? '55000' : '60000'); 
        
      const posSvc = new FuturesPositionService(database, futuresRiskService);
      const pos = await posSvc.createPosition({
          id: posId,
          accountId,
          symbol: 'BTCUSDT',
          side,
          quantity: qty,
          entryPrice,
          markPrice: entryPrice,
          liquidationPrice: lp,
          leverage,
          marginMode,
          initialMargin,
          maintenanceMarginRate: '0.005'
      } as any);
        return pos.id;
  };

  it('L1 should partially liquidate a CROSS LONG position by 50% and restore safety', async () => {
      const { accountId } = await setupUserAndDeposit('10000');
      
      const testLedger = new LedgerService(database);
      await testLedger.postTransaction({
          accountId,
          transactionType: 'FUTURES_MARGIN_LOCK',
          referenceId: crypto.randomUUID(),
          entries: [
              { accountId, asset: 'FUTURES_USDT', direction: 'DEBIT', amount: '5000', balancePool: 'available' },
              { accountId, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: '5000', balancePool: 'locked' },
          ]
      });

      const posId = await createOpenPosition(accountId, 'LONG', 'CROSS', '1', '50000', 10, '5000');
      
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '40100');
      
      const liqResult = await liquidationSvc.evaluateAndLiquidate(posId, '40100');
      
      expect(liqResult.liquidation.quantity).toBe('0.750000000000000000');
      expect(liqResult.finalStatus).toBe('OPEN');
      expect(liqResult.position.quantity).toBe('0.250000000000000000');
      expect(liqResult.position.initialMargin).toBe('1250.000000000000000000');
      
      const posSvc = new FuturesPositionService(database, futuresRiskService);
      const updatedPos = await posSvc.getPositionById(posId);
      expect(updatedPos?.quantity).toBe('0.250000000000000000');
      expect(updatedPos?.status).toBe('OPEN');
  });

  it('L2 should fully liquidate a CROSS SHORT position if the 50% step leaves notional below 100 USDT', async () => {
      const { accountId } = await setupUserAndDeposit('100');
      
      const testLedger = new LedgerService(database);
      await testLedger.postTransaction({
          accountId,
          transactionType: 'FUTURES_MARGIN_LOCK',
          referenceId: crypto.randomUUID(),
          entries: [
              { accountId, asset: 'FUTURES_USDT', direction: 'DEBIT', amount: '10', balancePool: 'available' },
              { accountId, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: '10', balancePool: 'locked' },
          ]
      });

      const posId = await createOpenPosition(accountId, 'SHORT', 'CROSS', '0.002', '50000', 10, '10');
      
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '100000');
      
      const liqResult = await liquidationSvc.evaluateAndLiquidate(posId, '100000');
      
      expect(liqResult.liquidation.quantity).toBe('0.002000000000000000');
      expect(liqResult.finalStatus).toBe('LIQUIDATED');
      
      const posSvc = new FuturesPositionService(database, futuresRiskService);
      const updatedPos = await posSvc.getPositionById(posId);
      expect(updatedPos?.status).toBe('LIQUIDATED');
      expect(updatedPos?.quantity).toBe('0.000000000000000000');
  });

  it('L3 should fully liquidate a BANKRUPT ISOLATED LONG position (Equity <= 0) without partial attempts', async () => {
      const { accountId } = await setupUserAndDeposit('10000');
      
      const testLedger = new LedgerService(database);
      await testLedger.postTransaction({
          accountId,
          transactionType: 'FUTURES_MARGIN_LOCK',
          referenceId: crypto.randomUUID(),
          entries: [
              { accountId, asset: 'FUTURES_USDT', direction: 'DEBIT', amount: '1000', balancePool: 'available' },
              { accountId, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: '1000', balancePool: 'locked' },
          ]
      });

      const posId = await createOpenPosition(accountId, 'LONG', 'ISOLATED', '1', '50000', 50, '1000');
      
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '48000');
      
      const liqResult = await liquidationSvc.evaluateAndLiquidate(posId, '48000');
      
      expect(liqResult.liquidation.quantity).toBe('1.000000000000000000');
      expect(liqResult.finalStatus).toBe('LIQUIDATED');
      
      const posSvc = new FuturesPositionService(database, futuresRiskService);
      const updatedPos = await posSvc.getPositionById(posId);
      expect(updatedPos?.status).toBe('LIQUIDATED');
      expect(updatedPos?.quantity).toBe('0.000000000000000000');
      
      expect(decimalCompare(liqResult.deficit, '0')).toBeGreaterThan(0);
  });
  
  it('L4 should fully liquidate an ISOLATED SHORT position iteratively because partial liquidation does not restore safety', async () => {
      const { accountId } = await setupUserAndDeposit('10000');
      
      const testLedger = new LedgerService(database);
      await testLedger.postTransaction({
          accountId,
          transactionType: 'FUTURES_MARGIN_LOCK',
          referenceId: crypto.randomUUID(),
          entries: [
              { accountId, asset: 'FUTURES_USDT', direction: 'DEBIT', amount: '5000', balancePool: 'available' },
              { accountId, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: '5000', balancePool: 'locked' },
          ]
      });

      const posId = await createOpenPosition(accountId, 'SHORT', 'ISOLATED', '1', '50000', 10, '5000');
      
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '54800');
      
      const liqResult = await liquidationSvc.evaluateAndLiquidate(posId, '54800');
      
      expect(liqResult.liquidation.quantity).toBe('1.000000000000000000');
      expect(liqResult.finalStatus).toBe('LIQUIDATED');
  });

});
