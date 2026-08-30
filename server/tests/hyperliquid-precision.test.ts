import { describe, it, expect, vi } from 'vitest';
import { HyperliquidAdapter } from '../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import { decimalCompare } from '../src/services/ledger/decimal';

describe('HyperliquidAdapter Precision (P2-2)', () => {
  it('should use exact string truncation in formatQuantity', () => {
    // Access private method for testing using any cast
    const adapter = new HyperliquidAdapter({ baseUrl: 'http://test', isMainnet: false } as any) as any;

    expect(adapter.formatQuantity('1.23456789', 5)).toBe('1.23456');
    expect(adapter.formatQuantity('1.23456789', 2)).toBe('1.23');
    expect(adapter.formatQuantity('1', 2)).toBe('1.00');
    expect(adapter.formatQuantity('1.000', 0)).toBe('1');
    expect(adapter.formatQuantity('1.99999', 2)).toBe('1.99'); // No rounding, strict truncation
  });

  it('decimalCompare works for exact math instead of parseFloat', () => {
    expect(decimalCompare('1.23', '1.230')).toBe(0);
    expect(decimalCompare('0.000000000000000001', '0')).toBe(1);
  });
});
