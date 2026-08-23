import { describe, it, expect, beforeEach } from 'vitest';
import { FuturesFeeService } from './FuturesFeeService';

describe.skip('Futures Fee System', () => {
  let feeService: FuturesFeeService;

  beforeEach(() => {
    feeService = new FuturesFeeService();
  });

  it('1. Maker fee should be calculated correctly', () => {
    // 63000 * 0.10 = 6300 Notional. 6300 * 0.0002 = 1.26
    const result = feeService.calculateExecutionFee('0.10', '63000', true);
    expect(result.feeAmount).toBe('1.26');
    expect(result.feeRate).toBe('0.0002');
    expect(result.feeType).toBe('MAKER');
  });

  it('2. Taker fee should be calculated correctly', () => {
    // 63000 * 0.10 = 6300 Notional. 6300 * 0.0005 = 3.15
    const result = feeService.calculateExecutionFee('0.10', '63000', false);
    expect(result.feeAmount).toBe('3.15');
    expect(result.feeRate).toBe('0.0005');
    expect(result.feeType).toBe('TAKER');
  });

  it('3. Market-order fee (Estimated) uses TAKER', () => {
    const result = feeService.getEstimatedFee('0.10', '63000', 'MARKET');
    expect(result.feeAmount).toBe('3.15');
    expect(result.feeType).toBe('TAKER');
  });

  it('4. Limit-order fee (Estimated) uses MAKER', () => {
    const result = feeService.getEstimatedFee('0.10', '63000', 'LIMIT');
    expect(result.feeAmount).toBe('1.26');
    expect(result.feeType).toBe('MAKER');
  });

});
