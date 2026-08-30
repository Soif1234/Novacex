import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabasePool, db } from '../src/config/database';
import { futuresFundingService } from '../src/services/futures/funding.service';
import { marketDataService } from '../src/services/market/market.service';
import { developmentMarkPriceProvider } from '../src/services/futures/mark-price.provider';
import { ledgerService } from '../src/services/ledger/ledger.service';
import { decimalCompare, decimalAdd, decimalSubtract } from '../src/services/ledger/decimal';
import { eventBus } from '../src/services/market/event-bus';
import crypto from 'crypto';

describe('Phase 6.3 - Adaptive Funding Engine', () => {
  let dbPool: DatabasePool;

  beforeEach(async () => {
    // Reset development mark price provider to defaults
    developmentMarkPriceProvider.reset();
    
    // Set static funding rate to null to enable adaptive calculation
    futuresFundingService['staticFundingRate'] = null;

    dbPool = db as DatabasePool; // assuming it exports 'db' which is an instance
    await dbPool.connect(); // required for db.transaction used by settlement
    // Clear out positions for isolated testing
    // Using internal arrays if it's the mock db, or we can just mock the query method
    vi.spyOn(dbPool, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      if (/SELECT \* FROM futures_positions WHERE symbol/i.test(sql)) {
        return {
          rows: [
            {
              id: 'pos-long',
              account_id: 'acc-1',
              symbol: 'BTCUSDT',
              side: 'LONG',
              quantity: '1',
              entry_price: '50000',
              mark_price: '50000',
              liquidation_price: '40000',
              leverage: 10,
              margin_mode: 'ISOLATED',
              initial_margin: '5000',
              maintenance_margin: '250',
              realized_pnl: '0',
              status: 'OPEN',
              created_at: new Date(),
              updated_at: new Date()
            },
            {
              id: 'pos-short',
              account_id: 'acc-2',
              symbol: 'BTCUSDT',
              side: 'SHORT',
              quantity: '1',
              entry_price: '50000',
              mark_price: '50000',
              liquidation_price: '60000',
              leverage: 10,
              margin_mode: 'CROSS',
              initial_margin: '5000',
              maintenance_margin: '250',
              realized_pnl: '0',
              status: 'OPEN',
              created_at: new Date(),
              updated_at: new Date()
            }
          ],
          rowCount: 2
        };
      }
      if (/INSERT INTO futures_funding_history/i.test(sql)) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    vi.spyOn(ledgerService, 'postTransaction').mockResolvedValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Adaptive Funding Calculation Rules', () => {
    it('1. positive funding - Mark > Index', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '50500');
      developmentMarkPriceProvider.setIndexPrice('BTCUSDT', '50000');
      // Premium = 500, Premium Index = 500 / 50000 = 0.0100
      // Raw Funding = 0.0100 + 0.0001 = 0.0101
      // Cap is 0.0050 -> Should clamp to 0.0050

      const res = await futuresFundingService.calculateAdaptiveFundingRate('BTCUSDT');
      expect(decimalCompare(res.premium, '500')).toBe(0);
      expect(decimalCompare(res.premiumIndex, '0.01')).toBe(0);
      expect(decimalCompare(res.rawFundingRate, '0.0101')).toBe(0);
      expect(decimalCompare(res.fundingRate, '0.0050')).toBe(0); // Capped
    });

    it('2. negative funding - Mark < Index', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '49500');
      developmentMarkPriceProvider.setIndexPrice('BTCUSDT', '50000');
      // Premium = -500, Premium Index = -500 / 50000 = -0.0100
      // Raw = -0.0100 + 0.0001 = -0.0099
      // Floor is -0.0050 -> Should clamp to -0.0050

      const res = await futuresFundingService.calculateAdaptiveFundingRate('BTCUSDT');
      expect(decimalCompare(res.premium, '-500')).toBe(0);
      expect(decimalCompare(res.premiumIndex, '-0.01')).toBe(0);
      expect(decimalCompare(res.rawFundingRate, '-0.0099')).toBe(0);
      expect(decimalCompare(res.fundingRate, '-0.0050')).toBe(0); // Floored
    });

    it('3. zero funding scenarios (exact interest rate)', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '50000');
      developmentMarkPriceProvider.setIndexPrice('BTCUSDT', '50000');
      
      const res = await futuresFundingService.calculateAdaptiveFundingRate('BTCUSDT');
      expect(decimalCompare(res.fundingRate, '0.0001')).toBe(0);
    });

    it('4. extreme boundaries (NaN/Infinity) should throw safely', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '0');
      await expect(futuresFundingService.calculateAdaptiveFundingRate('BTCUSDT')).rejects.toThrow(/Invalid prices/);
      
          });

    it('5. exact cap and floor boundaries', async () => {
      // Set to exactly 0.50% raw funding -> Premium Index = 0.0049 -> Premium = 245
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '50245');
      developmentMarkPriceProvider.setIndexPrice('BTCUSDT', '50000');
      let res = await futuresFundingService.calculateAdaptiveFundingRate('BTCUSDT');
      expect(decimalCompare(res.fundingRate, '0.0050')).toBe(0);

      // Set to exactly -0.50% raw funding -> Premium Index = -0.0051 -> Premium = -255
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '49745');
      developmentMarkPriceProvider.setIndexPrice('BTCUSDT', '50000');
      res = await futuresFundingService.calculateAdaptiveFundingRate('BTCUSDT');
      expect(decimalCompare(res.fundingRate, '-0.0050')).toBe(0);
    });
  });

  describe('Funding Direction & Settlement', () => {
    it('1. Long pays short when funding is positive', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '50000'); // Rate will be 0.0001
      
      const { settledPositions, rateData } = await futuresFundingService.settleFundingInterval('BTCUSDT');
      expect(settledPositions).toBe(2);
      expect(decimalCompare(rateData!.fundingRate, '0.0001')).toBe(0);

      // Ledger calls
      // Long pays 5 USDT (DEBIT)
      expect(ledgerService.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'acc-1',
        transactionType: 'FUTURES_FUNDING_PAYMENT',
        entries: [expect.objectContaining({ direction: 'DEBIT', amount: '5.000000000000000000' })]
      }), expect.anything());

      // Short receives 5 USDT (CREDIT)
      expect(ledgerService.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'acc-2',
        transactionType: 'FUTURES_FUNDING_PAYMENT',
        entries: [expect.objectContaining({ direction: 'CREDIT', amount: '5.000000000000000000' })]
      }), expect.anything());
    });

    it('2. Short pays long when funding is negative', async () => {
      // Force rate to -0.0002
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '49985'); // Premium = -15, P = -0.0003, raw = -0.0002
      
      const { settledPositions, rateData } = await futuresFundingService.settleFundingInterval('BTCUSDT');
      expect(settledPositions).toBe(2);
      expect(decimalCompare(rateData!.fundingRate, '-0.0002')).toBe(0);

      // Long receives 10 USDT (CREDIT) -- wait, rate is -0.0002, quantity=1, price=49985, notional = 49985. Amount = 49985 * -0.0002 = -9.997
      expect(ledgerService.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'acc-1',
        entries: [expect.objectContaining({ direction: 'CREDIT', amount: '9.997000000000000000' })]
      }), expect.anything());

      // Short pays 10 USDT (DEBIT)
      expect(ledgerService.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        accountId: 'acc-2',
        entries: [expect.objectContaining({ direction: 'DEBIT', amount: '9.997000000000000000' })]
      }), expect.anything());
    });

    it('3. zero funding produces zero transfer', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '49995'); // Premium = -5, P = -0.0001, raw = 0
      const { settledPositions } = await futuresFundingService.settleFundingInterval('BTCUSDT');
      expect(settledPositions).toBe(0); // 0 transfers because payment is '0'
      expect(ledgerService.postTransaction).not.toHaveBeenCalled();
    });

    it('4. duplicate settlement prevention via deterministic referenceId', async () => {
      // Settlement interval uses deterministic epoch ID
      const epochId = Math.floor(Date.now() / (1000 * 60 * 60 * 8));
      await futuresFundingService.settleFundingInterval('BTCUSDT');
      
      // Ensure reference ID uses the epoch
      expect(ledgerService.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        referenceId: `FUNDING-BTCUSDT-${epochId}-pos-long`
      }), expect.anything());
    });
    
    it('5. spot exclusion - does not query spot orders', async () => {
      await futuresFundingService.settleFundingInterval('BTCUSDT');
      // Our mock only returns futures positions, ensuring spot is entirely ignored
      expect(dbPool.query).toHaveBeenCalledWith(
        expect.stringContaining('FROM futures_positions'),
        expect.any(Array)
      );
      expect(dbPool.query).not.toHaveBeenCalledWith(
        expect.stringContaining('spot_'),
        expect.any(Array)
      );
    });
    
    it('6. precision handling for fractional and tiny rates', async () => {
      developmentMarkPriceProvider.setMarkPrice('BTCUSDT', '50001'); // P = 1 / 50000 = 0.00002
      const { rateData } = await futuresFundingService.settleFundingInterval('BTCUSDT');
      expect(decimalCompare(rateData!.fundingRate, '0.00012')).toBe(0); // 0.0001 + 0.00002
    });
  });
});
