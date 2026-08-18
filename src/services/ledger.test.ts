import { describe, it, expect, beforeEach } from 'vitest';
import { DemoLedger } from './ledger';

describe('DemoLedger', () => {
  let ledger: DemoLedger;

  beforeEach(() => {
    // Use persist=false to avoid localStorage in node environment
    ledger = new DemoLedger(false);
  });

  it('should initialize with correct default balances', () => {
    expect(ledger.getBalance('USDT')).toBe('10000');
    expect(ledger.getBalance('BTC')).toBe('0');
  });

  it('should properly credit an asset', () => {
    ledger.credit('USDT', '500.5', 'Test deposit');
    expect(ledger.getBalance('USDT')).toBe('10500.5');

    ledger.credit('BTC', '2.5', 'Test buy');
    expect(ledger.getBalance('BTC')).toBe('2.5');

    const history = ledger.getHistory();
    expect(history.length).toBe(2);
    // Unshift means the most recent is at index 0
    expect(history[0].type).toBe('credit');
    expect(history[0].balanceBefore).toBe('0'); // BTC
    expect(history[0].balanceAfter).toBe('2.5');
    
    expect(history[1].type).toBe('credit');
    expect(history[1].balanceBefore).toBe('10000'); // USDT
    expect(history[1].balanceAfter).toBe('10500.5');
  });

  it('should properly debit an asset', () => {
    ledger.debit('USDT', '1000', 'Test withdrawal');
    expect(ledger.getBalance('USDT')).toBe('9000');

    const history = ledger.getHistory();
    expect(history.length).toBe(1);
    expect(history[0].type).toBe('debit');
    expect(history[0].balanceBefore).toBe('10000');
    expect(history[0].balanceAfter).toBe('9000');
  });

  it('should throw an error on insufficient balance', () => {
    expect(() => {
      ledger.debit('USDT', '10001', 'Overdraw');
    }).toThrow('Insufficient balance for USDT');

    // Balance should remain unchanged
    expect(ledger.getBalance('USDT')).toBe('10000');
  });

  it('should handle repeated transactions with precision', () => {
    // Test precision (JS float would mess up 0.1 + 0.2)
    ledger.credit('BTC', '0.1', 'Buy 1');
    ledger.credit('BTC', '0.2', 'Buy 2');
    
    expect(ledger.getBalance('BTC')).toBe('0.3');
    
    // Debit
    ledger.debit('BTC', '0.3', 'Sell all');
    expect(ledger.getBalance('BTC')).toBe('0');
  });

  it('should reject negative or zero amounts', () => {
    expect(() => {
      ledger.credit('USDT', '-100', 'Negative credit');
    }).toThrow('Credit amount must be positive');

    expect(() => {
      ledger.debit('USDT', '0', 'Zero debit');
    }).toThrow('Debit amount must be positive');
  });
});
