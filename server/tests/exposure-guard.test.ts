import { describe, it, expect } from 'vitest';
import { ExposureGuard } from '../src/services/liquidity/exposure.guard';
import { ExposureGuardInputs, RiskLimits } from '../src/domain/liquidity/exposure-guard.interface';

describe('ExposureGuard', () => {
  const guard = new ExposureGuard();

  const defaultLimits: RiskLimits = {
    maxHouseExposure: '100',
    maxHedgeSize: '10',
    maxExternalPosition: '100',
    maxOutstandingHedgeOrders: '5'
  };

  const defaultInputs: ExposureGuardInputs = {
    currentHouseExposure: '0',
    pendingHedgeQuantity: '5',
    externalPosition: '0',
    pendingExternalOrdersQuantity: '0',
    market: 'BTC-PERP',
    marketDataFreshness: 'HEALTHY',
    proposedHedgeSide: 'BUY',
    hyperliquidReduceOnly: false,
    hyperliquidHedgeHalt: false
  };

  it('should allow valid hedge', () => {
    const decision = guard.evaluateHedge(defaultInputs, defaultLimits);
    expect(decision.result).toBe('ALLOW');
  });

  it('should halt if circuit breaker active', () => {
    const decision = guard.evaluateHedge({ ...defaultInputs, hyperliquidHedgeHalt: true }, defaultLimits);
    expect(decision.result).toBe('HALT');
  });

  it('should halt if market data is stale', () => {
    const decision = guard.evaluateHedge({ ...defaultInputs, marketDataFreshness: 'STALE' }, defaultLimits);
    expect(decision.result).toBe('HALT');
  });

  it('should reduce size if requested size exceeds maxHedgeSize', () => {
    const decision = guard.evaluateHedge({ ...defaultInputs, pendingHedgeQuantity: '15' }, defaultLimits);
    expect(decision.result).toBe('REDUCE_SIZE');
    expect(decision.allowedQuantity).toBe('10');
  });

  it('should reject if projected exposure exceeds maxHouseExposure', () => {
    const decision = guard.evaluateHedge({ ...defaultInputs, currentHouseExposure: '96', pendingHedgeQuantity: '5' }, defaultLimits);
    expect(decision.result).toBe('REJECT');
  });

  it('should allow reduce-only trades if reducing risk', () => {
    const decision = guard.evaluateHedge({
      ...defaultInputs,
      currentHouseExposure: '10', // Long 10
      proposedHedgeSide: 'SELL',  // Selling reduces risk
      pendingHedgeQuantity: '5',
      hyperliquidReduceOnly: true
    }, defaultLimits);
    expect(decision.result).toBe('ALLOW');
  });

  it('should reject reduce-only trades if increasing risk', () => {
    const decision = guard.evaluateHedge({
      ...defaultInputs,
      currentHouseExposure: '10', // Long 10
      proposedHedgeSide: 'BUY',   // Buying increases risk
      hyperliquidReduceOnly: true
    }, defaultLimits);
    expect(decision.result).toBe('REDUCE_ONLY');
  });
});
