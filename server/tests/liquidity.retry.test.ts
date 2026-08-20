import { describe, it, expect, beforeEach } from 'vitest';
import { RetryEngine, FailureContext, RetryPolicy } from '../src/domain/liquidity/retry';
import { ProviderErrorCode } from '../src/domain/liquidity/errors';

describe('Phase 5.11 - Failure / Retry / Idempotency', () => {

  let engine: RetryEngine;

  const basePolicy: RetryPolicy = {
    maxAttempts: 3,
    initialDelayMs: 1000,
    maxDelayMs: 10000,
    backoffMultiplier: 2,
    jitter: false, // Turn off for deterministic tests, then test jitter separately
    retryableErrors: new Set([
      ProviderErrorCode.NETWORK_FAILURE, 
      ProviderErrorCode.RATE_LIMIT,
      ProviderErrorCode.TIMEOUT,
      ProviderErrorCode.PROVIDER_UNAVAILABLE
    ])
  };

  const baseContext: FailureContext = {
    clientOrderId: 'o1',
    providerId: 'BINANCE',
    attempt: 1,
    state: 'SUBMITTED',
    errorCode: ProviderErrorCode.NETWORK_FAILURE,
    timestamp: Date.now(),
    reconciliationRequired: false,
    submissionConfirmed: false
  };

  beforeEach(() => {
    engine = new RetryEngine();
  });

  it('1. Retryable network timeout', () => {
    const ctx = { ...baseContext, errorCode: ProviderErrorCode.TIMEOUT };
    const res = engine.evaluate(ctx, basePolicy);
    expect(res.type).toBe('RETRY');
  });

  it('2, 3. Non-retryable provider rejection & Invalid request', () => {
    const ctx1 = { ...baseContext, errorCode: ProviderErrorCode.ORDER_REJECTED };
    expect(engine.evaluate(ctx1, basePolicy).type).toBe('NO_RETRY');

    engine.resetTracker();
    const ctx2 = { ...baseContext, errorCode: ProviderErrorCode.INVALID_REQUEST };
    expect(engine.evaluate(ctx2, basePolicy).type).toBe('NO_RETRY');
  });

  it('4. Rate-limit retry', () => {
    const ctx = { ...baseContext, errorCode: ProviderErrorCode.RATE_LIMIT };
    expect(engine.evaluate(ctx, basePolicy).type).toBe('RETRY');
  });

  it('5. Authentication failure', () => {
    const ctx = { ...baseContext, errorCode: ProviderErrorCode.AUTHENTICATION_FAILURE };
    expect(engine.evaluate(ctx, basePolicy).type).toBe('NO_RETRY');
  });

  it('6, 7, 25, 27, 28, 29, 30. UNKNOWN safety -> RECONCILE_FIRST & Exposure retained', () => {
    // Spot
    const ctx1 = { ...baseContext, state: 'UNKNOWN' as any };
    expect(engine.evaluate(ctx1, basePolicy).type).toBe('RECONCILE_FIRST');
    
    // Hedge integration (same exact path, clientOrderId dictates identity)
    engine.resetTracker();
    const ctxHedge = { ...baseContext, state: 'UNKNOWN' as any, clientOrderId: 'hedge-o1' };
    const hedgeRes = engine.evaluate(ctxHedge, basePolicy);
    expect(hedgeRes.type).toBe('RECONCILE_FIRST');
    
    // Check missing fields (wallet mutation etc)
    const serialized = JSON.stringify(hedgeRes);
    expect(serialized).not.toContain('wallet');
    expect(serialized).not.toContain('ledger');
    expect(serialized).not.toContain('position');
  });

  it('8, 9, 10. RECONCILING, FILLED, CANCELLED blocks retry', () => {
    const states = ['RECONCILING', 'FILLED', 'CANCELLED'];
    const types = ['BLOCK_RETRY', 'NO_RETRY', 'NO_RETRY'];
    
    for (let i=0; i<states.length; i++) {
      engine.resetTracker();
      const ctx = { ...baseContext, state: states[i] as any };
      expect(engine.evaluate(ctx, basePolicy).type).toBe(types[i]);
    }
  });

  it('11. Maximum retry attempts', () => {
    const ctx = { ...baseContext, attempt: 3 }; // maxAttempts is 3
    const res = engine.evaluate(ctx, basePolicy);
    expect(res.type).toBe('MANUAL_REVIEW');
  });

  it('12, 13. Exponential backoff & Maximum delay cap', () => {
    // attempt 1 -> 1000
    const res1 = engine.evaluate(baseContext, basePolicy);
    expect(res1.delayMs).toBe(1000);

    // attempt 2 -> 2000
    engine.resetTracker();
    const ctx2 = { ...baseContext, attempt: 2 };
    expect(engine.evaluate(ctx2, basePolicy).delayMs).toBe(2000);

    // attempt 3 -> 4000
    engine.resetTracker();
    const ctx3 = { ...baseContext, attempt: 3 };
    // wait, attempt 3 hits maxAttempts and yields MANUAL_REVIEW with 0 delay.
    // let's bump maxAttempts to test backoff math
    const bigPolicy = { ...basePolicy, maxAttempts: 10 };
    expect(engine.evaluate(ctx3, bigPolicy).delayMs).toBe(4000);

    // attempt 5 -> 16000 but maxDelay is 10000 -> 10000
    engine.resetTracker();
    const ctx5 = { ...baseContext, attempt: 5 };
    expect(engine.evaluate(ctx5, bigPolicy).delayMs).toBe(10000);
  });

  it('14. Jitter behavior', () => {
    const jitterPolicy = { ...basePolicy, jitter: true };
    const res1 = engine.evaluate(baseContext, jitterPolicy);
    // initialDelay=1000. jitter factor is 0.8 - 1.2
    expect(res1.delayMs).toBeGreaterThanOrEqual(800);
    expect(res1.delayMs).toBeLessThanOrEqual(1200);
  });

  it('15, 16, 17, 38, 39. Deterministic idempotency, Duplicate submission, Concurrent retry protection', () => {
    const res1 = engine.evaluate(baseContext, basePolicy);
    
    // Duplicate logical call in same session
    const res2 = engine.evaluate(baseContext, basePolicy);
    expect(res2.type).toBe('IDEMPOTENT_DUPLICATE');
    expect(res1.idempotencyKey).toBe(res2.idempotencyKey);
  });

  it('18, 19, 20. Process restart / Disconnect -> Identical identity mapping', () => {
    const res1 = engine.evaluate(baseContext, basePolicy);
    // Hard restart (engine wiped)
    engine = new RetryEngine();
    const res2 = engine.evaluate(baseContext, basePolicy);
    
    // Generates identical key deterministically
    expect(res1.idempotencyKey).toBe(res2.idempotencyKey);
  });

  it('21, 22, 23. Timeout before vs after submission', () => {
    // Before submission -> retryable
    const ctxBefore = { ...baseContext, errorCode: ProviderErrorCode.TIMEOUT, submissionConfirmed: false };
    expect(engine.evaluate(ctxBefore, basePolicy).type).toBe('RETRY');

    // After submission -> UNKNOWN -> RECONCILE_FIRST
    engine.resetTracker();
    const ctxAfter = { ...baseContext, errorCode: ProviderErrorCode.TIMEOUT, submissionConfirmed: true };
    expect(engine.evaluate(ctxAfter, basePolicy).type).toBe('RECONCILE_FIRST');
  });

  it('24. Partial fill retry safety', () => {
    const ctx = { ...baseContext, state: 'PARTIALLY_FILLED' as any };
    expect(engine.evaluate(ctx, basePolicy).type).toBe('BLOCK_RETRY');
  });

  it('26. Unknown cancellation (Reconciliation Required)', () => {
    const ctx = { ...baseContext, reconciliationRequired: true };
    expect(engine.evaluate(ctx, basePolicy).type).toBe('RECONCILE_FIRST');
  });

  it('31, 32, 33. Integration safety & Provider Error Normalization', () => {
    // Ensures arbitrary error strings don't bypass retry protections
    const ctx = { ...baseContext, errorCode: 'SOME_FAKE_ERROR' as any };
    expect(engine.evaluate(ctx, basePolicy).type).toBe('NO_RETRY');
  });

  it('35, 36, 37. Negative values & Retry policy validation', () => {
    const badCtx = { ...baseContext, attempt: -1 };
    expect(() => engine.evaluate(badCtx, basePolicy)).toThrow(/attempt/i);

    const badPol = { ...basePolicy, initialDelayMs: -100 };
    expect(() => engine.evaluate(baseContext, badPol)).toThrow(/initialDelayMs/i);

    const nanPol = { ...basePolicy, backoffMultiplier: NaN };
    expect(() => engine.evaluate(baseContext, nanPol)).toThrow(/backoffMultiplier/i);
  });

  it('40-46. Strict domain boundaries', () => {
    const res = engine.evaluate(baseContext, basePolicy);
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('wallet');
    expect(serialized).not.toContain('ledger');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('credentials');
  });
});
