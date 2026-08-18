import { describe, it, expect, beforeEach, vi } from 'vitest';
import { 
  safeParseJSON, 
  safeParseArray, 
  safeParseObject, 
  isValidFinancialString, 
  safeParseFinancialNumber, 
  safeParseFinancialString, 
  safeFormatDate 
} from './storageUtil';
import { ledgerService } from './wallet/LedgerService';
import { futuresOrderService } from './futures/FuturesOrderService';
import { orderService } from './OrderService';
import { orderCoreService } from './orders/OrderCoreService';
import { demoTransactionService } from './wallet/DemoTransactionService';
import { internalTransferService } from './wallet/InternalTransferService';
import { priceAlertService } from './alerts/PriceAlertService';
import { userPreferencesStore } from '../store/userPreferencesStore';

describe('Phase 2 — UI Concurrency & Defensive Data Handling Test Suite', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    ledgerService.reset();
    futuresOrderService.reset();
    orderService.reset();
  });

  describe('Part A — Safe JSON Parsing & Defensive Primitives', () => {
    it('1. safeParseJSON handles null, undefined, malformed JSON, and unexpected types without throwing', () => {
      expect(safeParseJSON(null, { fallback: true })).toEqual({ fallback: true });
      expect(safeParseJSON(undefined, 42)).toBe(42);
      expect(safeParseJSON('', [])).toEqual([]);
      expect(safeParseJSON('   ', 'fallback')).toBe('fallback');
      expect(safeParseJSON('{ invalid json', { fallback: true })).toEqual({ fallback: true });
      expect(safeParseJSON('{"valid": 123}', {})).toEqual({ valid: 123 });
    });

    it('2. safeParseJSON with validator function correctly rejects non-conforming structures', () => {
      const validator = (obj: any) => typeof obj?.id === 'string' && typeof obj?.val === 'number';
      expect(safeParseJSON('{"id": "abc", "val": 10}', null, validator)).toEqual({ id: 'abc', val: 10 });
      expect(safeParseJSON('{"id": 123, "val": 10}', null, validator)).toBeNull();
      expect(safeParseJSON('"just a string"', null, validator)).toBeNull();
    });

    it('3. safeParseArray protects against JSON primitives (number, string, boolean, null) and corrupted items', () => {
      // In JS, JSON.parse("123") is 123, JSON.parse('"hello"') is "hello". Calling .filter() on them causes TypeError!
      expect(safeParseArray('123')).toEqual([]);
      expect(safeParseArray('"string"')).toEqual([]);
      expect(safeParseArray('true')).toEqual([]);
      expect(safeParseArray('null')).toEqual([]);
      expect(safeParseArray('{ "a": 1 }')).toEqual([]);
      
      // Corrupted array items filtered out
      const mixed = JSON.stringify([null, undefined, 123, "text", { id: 'valid-1' }, false, { id: 'valid-2' }]);
      const parsed = safeParseArray(mixed, item => typeof item.id === 'string');
      expect(parsed).toEqual([{ id: 'valid-1' }, { id: 'valid-2' }]);
    });

    it('4. safeParseObject protects against arrays, primitives, and corrupt payloads', () => {
      expect(safeParseObject('123', { def: 1 })).toEqual({ def: 1 });
      expect(safeParseObject('[1, 2, 3]', { def: 1 })).toEqual({ def: 1 });
      expect(safeParseObject('{"theme": "dark"}', { theme: 'light' })).toEqual({ theme: 'dark' });
    });
  });

  describe('Part B — Financial Data & String Validation', () => {
    it('5. isValidFinancialString strictly rejects NaN, Infinity, null, empty string, and junk text', () => {
      expect(isValidFinancialString(null)).toBe(false);
      expect(isValidFinancialString(undefined)).toBe(false);
      expect(isValidFinancialString('')).toBe(false);
      expect(isValidFinancialString('   ')).toBe(false);
      expect(isValidFinancialString('NaN')).toBe(false);
      expect(isValidFinancialString('Infinity')).toBe(false);
      expect(isValidFinancialString('-Infinity')).toBe(false);
      expect(isValidFinancialString('abc')).toBe(false);
      expect(isValidFinancialString({})).toBe(false);
      expect(isValidFinancialString([])).toBe(false);

      // Valid financial numbers
      expect(isValidFinancialString('0')).toBe(true);
      expect(isValidFinancialString('100.50')).toBe(true);
      expect(isValidFinancialString('0.00000001')).toBe(true);
      expect(isValidFinancialString(500)).toBe(true);
    });

    it('6. safeParseFinancialNumber and safeParseFinancialString produce safe deterministic fallbacks', () => {
      expect(safeParseFinancialNumber('NaN', 0)).toBe(0);
      expect(safeParseFinancialNumber(Infinity, 100)).toBe(100);
      expect(safeParseFinancialNumber('45.67')).toBe(45.67);
      expect(safeParseFinancialNumber(null, 10)).toBe(10);

      expect(safeParseFinancialString('NaN', '0')).toBe('0');
      expect(safeParseFinancialString('Infinity', '0')).toBe('0');
      expect(safeParseFinancialString(' 123.456000 ')).toBe('123.456');
      expect(safeParseFinancialString(null, '50')).toBe('50');
    });
  });

  describe('Part C — Safe Date Formatting', () => {
    it('7. safeFormatDate never throws and returns fallback on invalid dates', () => {
      expect(safeFormatDate(null)).toBe('Date unavailable');
      expect(safeFormatDate(undefined)).toBe('Date unavailable');
      expect(safeFormatDate('')).toBe('Date unavailable');
      expect(safeFormatDate('invalid-date-string')).toBe('Date unavailable');
      expect(safeFormatDate(NaN)).toBe('Date unavailable');
      
      const now = Date.now();
      expect(safeFormatDate(now)).toContain(new Date(now).getFullYear().toString());
    });
  });

  describe('Part D — Storage Corruption Recovery in Services', () => {
    it('8. LedgerService recovers cleanly from corrupted sessionStorage without crashing', () => {
      sessionStorage.setItem('mallick_ledger_balances', '{ corrupt-json: 123');
      sessionStorage.setItem('mallick_ledger_history', '"just a string primitive"');

      expect(() => (ledgerService as any).load()).not.toThrow();
      expect(ledgerService.getBalance('SPOT_USDT')).toBe('0');
      expect(ledgerService.getEntries()).toEqual([]);
    });

    it('9. FuturesOrderService recovers cleanly from corrupted sessionStorage without crashing', () => {
      sessionStorage.setItem('mallick_futures_orders', '12345');
      sessionStorage.setItem('mallick_futures_trades', '{ bad json }');
      sessionStorage.setItem('mallick_futures_positions', 'true');

      expect(() => (futuresOrderService as any).load()).not.toThrow();
      expect(futuresOrderService.getOrders('demo-user-1')).toEqual([]);
      expect(futuresOrderService.getPositions('demo-user-1')).toEqual([]);
    });

    it('10. OrderService and OrderCoreService recover cleanly from malformed order arrays', () => {
      sessionStorage.setItem('demo_orders', JSON.stringify([
        null,
        { invalid: true },
        { id: 'spot-1', symbol: 'BTCUSDT', accountId: 'test-acc', side: 'BUY', type: 'LIMIT', price: 'NaN', quantity: '0.1', status: 'NEW', filledQuantity: '0', remainingQuantity: '0.1', fee: '0', feeAsset: 'USDT', total: 'NaN', createdAt: Date.now(), updatedAt: Date.now() },
        { id: 'spot-2', symbol: 'BTCUSDT', accountId: 'test-acc', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '0.1', status: 'NEW', filledQuantity: '0', remainingQuantity: '0.1', fee: '0', feeAsset: 'USDT', total: '5000', createdAt: Date.now(), updatedAt: Date.now() }
      ]));

      expect(() => (orderService as any).load()).not.toThrow();
      expect(orderCoreService.getOrders().length).toBe(1);
      expect(orderCoreService.getOrders()[0].id).toBe('spot-2');
    });

    it('11. DemoTransactionService and InternalTransferService recover from corrupted storage', () => {
      sessionStorage.setItem('mallick_demo_txs', '{ corrupt');
      sessionStorage.setItem('mallick_demo_transfers', '[ null, 123, "foo" ]');

      expect(() => (demoTransactionService as any).load()).not.toThrow();
      expect(() => (internalTransferService as any).load()).not.toThrow();
      expect(demoTransactionService.getTransactions()).toEqual([]);
      expect(internalTransferService.getTransfers()).toEqual([]);
    });

    it('12. PriceAlertService recovers from corrupted alert arrays', () => {
      sessionStorage.setItem('mallick_price_alerts', '["string-not-object", null]');
      expect(() => (priceAlertService as any).load()).not.toThrow();
      expect(priceAlertService.getAlerts()).toEqual([]);
    });

    it('13. userPreferencesStore recovers from malformed localStorage primitives', () => {
      localStorage.setItem('nova_favorites', '12345');
      expect(() => userPreferencesStore.reload()).not.toThrow();
      expect(Array.isArray(userPreferencesStore.getFavorites())).toBe(true);

      localStorage.setItem('nova_favorites', '{ invalid json');
      expect(() => userPreferencesStore.reload()).not.toThrow();
      expect(Array.isArray(userPreferencesStore.getFavorites())).toBe(true);
    });
  });

  describe('Part E — UI Concurrency Simulation & Rapid Multi-Click Guards', () => {
    it('14. Synchronous ref lock blocks 5 concurrent rapid clicks during in-flight async action', async () => {
      let executionCount = 0;
      let isSubmitting = false;
      const isSubmittingRef = { current: false };

      const triggerAction = async () => {
        if (isSubmittingRef.current) {
          return 'BLOCKED';
        }
        isSubmittingRef.current = true;
        isSubmitting = true;

        try {
          // Simulate async network/processing delay
          await new Promise(resolve => setTimeout(resolve, 50));
          executionCount++;
          return 'EXECUTED';
        } finally {
          isSubmittingRef.current = false;
          isSubmitting = false;
        }
      };

      // Fire 5 rapid clicks concurrently
      const results = await Promise.all([
        triggerAction(),
        triggerAction(),
        triggerAction(),
        triggerAction(),
        triggerAction()
      ]);

      expect(executionCount).toBe(1);
      expect(results.filter(r => r === 'EXECUTED').length).toBe(1);
      expect(results.filter(r => r === 'BLOCKED').length).toBe(4);
      expect(isSubmittingRef.current).toBe(false);
      expect(isSubmitting).toBe(false);
    });

    it('15. Synchronous ref lock always releases on promise rejection / API error', async () => {
      let errorThrown = false;
      const isSubmittingRef = { current: false };

      const triggerFailingAction = async () => {
        if (isSubmittingRef.current) return 'BLOCKED';
        isSubmittingRef.current = true;

        try {
          await new Promise((_, reject) => setTimeout(() => reject(new Error('Network error')), 20));
        } finally {
          isSubmittingRef.current = false;
        }
      };

      try {
        await triggerFailingAction();
      } catch (err: any) {
        errorThrown = true;
      }

      expect(isSubmittingRef.current).toBe(false);

      // Subsequent action can run normally
      let secondExecuted = false;
      const triggerSuccessAction = async () => {
        if (isSubmittingRef.current) return 'BLOCKED';
        isSubmittingRef.current = true;
        try {
          secondExecuted = true;
          return 'SUCCESS';
        } finally {
          isSubmittingRef.current = false;
        }
      };

      const secondResult = await triggerSuccessAction();
      expect(secondExecuted).toBe(true);
      expect(secondResult).toBe('SUCCESS');
      expect(isSubmittingRef.current).toBe(false);
    });
  });
});
