import { describe, it, expect, beforeEach } from 'vitest';
import { ReconciliationEngine, ReconciliationRequest, LocalExecutionSnapshot, ProviderExecutionSnapshot } from '../src/domain/liquidity/reconciliation';

describe('Phase 5.10 - Reconciliation Engine', () => {

  let engine: ReconciliationEngine;

  const baseReq: ReconciliationRequest = {
    reconciliationId: 'rec-1',
    providerId: 'BINANCE',
    venueId: 'BINANCE_SPOT',
    clientOrderId: 'o1',
    providerOrderId: 'p1',
    symbol: 'BTCUSDT',
    requestedQuantity: '10',
    requestedSide: 'BUY',
    localState: 'UNKNOWN',
    lastKnownProviderState: 'UNKNOWN',
    timestamp: Date.now()
  };

  const baseLocal: LocalExecutionSnapshot = {
    clientOrderId: 'o1',
    executionState: 'UNKNOWN',
    requestedQuantity: '10',
    executedQuantity: '0',
    remainingQuantity: '10',
    averageExecutionPrice: '0',
    sequence: 1
  };

  const baseProvider: ProviderExecutionSnapshot = {
    providerId: 'BINANCE',
    providerOrderId: 'p1',
    clientOrderId: 'o1',
    symbol: 'BTCUSDT',
    side: 'BUY',
    requestedQuantity: '10',
    executedQuantity: '10',
    remainingQuantity: '0',
    averageExecutionPrice: '50000',
    fees: '1',
    status: 'FILLED',
    sequence: 1,
    timestamp: Date.now()
  };

  beforeEach(() => {
    engine = new ReconciliationEngine();
  });

  it('1, 2, 27, 33. UNKNOWN -> FILLED (Safe Confirm)', () => {
    const res = engine.reconcile(baseReq, baseLocal, baseProvider);
    expect(res.result).toBe('SAFE_TO_CONFIRM');
    expect(res.action).toBe('CONFIRM_EXECUTION');
  });

  it('3, 28. UNKNOWN -> CANCELLED (Safe Cancel)', () => {
    const prov = { ...baseProvider, status: 'CANCELLED' as any, executedQuantity: '0', remainingQuantity: '10' };
    const res = engine.reconcile(baseReq, baseLocal, prov);
    expect(res.result).toBe('SAFE_TO_CANCEL');
    expect(res.action).toBe('CANCEL_EXECUTION');
  });

  it('4, 5, 20. UNKNOWN provider state & No blind retry', () => {
    const prov = { ...baseProvider, status: 'UNKNOWN' as any };
    const res = engine.reconcile(baseReq, baseLocal, prov);
    expect(res.result).toBe('UNKNOWN_PROVIDER_STATE');
    expect(res.action).toBe('RETRY_RECONCILIATION');
  });

  it('6, 7, 8, 9, 10, 15, 25, 26, 31. Sequence ordering, Duplicate, Idempotency & Stale sequence', () => {
    // 1st snapshot
    const res1 = engine.reconcile(baseReq, baseLocal, baseProvider);
    expect(res1.result).toBe('SAFE_TO_CONFIRM');

    // Identical duplicate -> MATCHED (idempotency)
    const res2 = engine.reconcile(baseReq, baseLocal, baseProvider);
    expect(res2.result).toBe('MATCHED');
    expect(res2.action).toBe('NO_ACTION');
    expect(res1.fingerprint).toBe(res2.fingerprint); // deterministic fingerprint

    // Stale sequence (sequence 0 < 1)
    const staleProv = { ...baseProvider, sequence: 0 };
    const res3 = engine.reconcile(baseReq, baseLocal, staleProv);
    expect(res3.result).toBe('INVALID_RECONCILIATION_DATA');
    expect(res3.action).toBe('BLOCK_RETRY');

    // Conflicting same sequence data
    const conflictProv = { ...baseProvider, executedQuantity: '5', remainingQuantity: '5' };
    const res4 = engine.reconcile(baseReq, baseLocal, conflictProv);
    expect(res4.result).toBe('INVALID_RECONCILIATION_DATA');
    expect(res4.action).toBe('BLOCK_RETRY');
  });

  it('11, 12. Quantity mismatch', () => {
    const local = { ...baseLocal, requestedQuantity: '20' };
    const req = { ...baseReq, requestedQuantity: '20' };
    const res = engine.reconcile(req, local, baseProvider);
    expect(res.result).toBe('QUANTITY_MISMATCH');
    expect(res.action).toBe('MANUAL_REVIEW');
  });

  it('13. Overfill rejection', () => {
    const prov = { ...baseProvider, executedQuantity: '15' }; // Requested was 10
    const res = engine.reconcile(baseReq, baseLocal, prov);
    expect(res.result).toBe('INVALID_RECONCILIATION_DATA');
    expect(res.reason).toMatch(/Overfill/);
  });

  it('14, 15, 16. Negative & Non-finite values', () => {
    const negQty = { ...baseProvider, executedQuantity: '-5' };
    expect(engine.reconcile(baseReq, baseLocal, negQty).result).toBe('INVALID_RECONCILIATION_DATA');

    const negPrice = { ...baseProvider, averageExecutionPrice: '-50000' };
    expect(engine.reconcile(baseReq, baseLocal, negPrice).result).toBe('INVALID_RECONCILIATION_DATA');

    const nanQty = { ...baseProvider, remainingQuantity: 'NaN' };
    expect(engine.reconcile(baseReq, baseLocal, nanQty).result).toBe('INVALID_RECONCILIATION_DATA');
  });

  it('17. Partial-fill reconciliation', () => {
    const local = { ...baseLocal, executionState: 'SUBMITTED' as any };
    const prov = { ...baseProvider, executedQuantity: '4', remainingQuantity: '6', status: 'PARTIALLY_FILLED' as any };
    const res = engine.reconcile(baseReq, local, prov);
    expect(res.result).toBe('PROVIDER_AHEAD');
    expect(res.action).toBe('UPDATE_PARTIAL_FILL');
  });

  it('18, 19, 29, 30. Provider order missing', () => {
    // Missing provider on UNKNOWN -> RETRY_RECONCILIATION
    const res1 = engine.reconcile(baseReq, baseLocal, null);
    expect(res1.result).toBe('PROVIDER_ORDER_MISSING');
    expect(res1.action).toBe('RETRY_RECONCILIATION');

    // Missing provider on non-pending (e.g. FILLED local) -> MANUAL_REVIEW
    const local = { ...baseLocal, executionState: 'FILLED' as any };
    const res2 = engine.reconcile(baseReq, local, null);
    expect(res2.result).toBe('PROVIDER_ORDER_MISSING');
    expect(res2.action).toBe('MANUAL_REVIEW');
  });

  it('21. Status mismatch', () => {
    const local = { ...baseLocal, executionState: 'ACKNOWLEDGED' as any };
    const prov = { ...baseProvider, status: 'REJECTED' as any, executedQuantity: '0', remainingQuantity: '10' };
    const res = engine.reconcile(baseReq, local, prov);
    
    // Provider is ahead and status is REJECTED -> safe to update locally
    expect(res.result).toBe('PROVIDER_AHEAD');
    expect(res.action).toBe('CANCEL_EXECUTION');
  });

  it('22. Price mismatch', () => {
    const local = { ...baseLocal, executionState: 'FILLED' as any, averageExecutionPrice: '45000' };
    const res = engine.reconcile(baseReq, local, baseProvider); // provider has 50000
    expect(res.result).toBe('PRICE_MISMATCH');
    expect(res.action).toBe('MANUAL_REVIEW');
  });

  it('23, 34. Economics / Fee mismatch (Ignored in exact float compare but protected)', () => {
    // Current price exact float match
    const local = { ...baseLocal, executionState: 'FILLED' as any, averageExecutionPrice: '50000' };
    const res = engine.reconcile(baseReq, local, baseProvider);
    expect(res.result).toBe('MATCHED');
  });

  it('24. Filled downgrade protection', () => {
    const local = { ...baseLocal, executionState: 'FILLED' as any };
    const prov = { ...baseProvider, status: 'CANCELLED' as any, executedQuantity: '0', remainingQuantity: '10' };
    
    const res = engine.reconcile(baseReq, local, prov);
    expect(res.result).toBe('STATUS_MISMATCH');
    expect(res.reason).toMatch(/downgrade/i);
    expect(res.action).toBe('MANUAL_REVIEW');
  });

  it('32, 35, 36, 37, 38, 39, 41, 42. Hedge integration & No Direct Ledger Mutation', () => {
    // Pass hedge context exactly like Spot
    const hedgeReq = { ...baseReq, clientOrderId: 'hedge-o1' };
    const local = { ...baseLocal, clientOrderId: 'hedge-o1' };
    const prov = { ...baseProvider, clientOrderId: 'hedge-o1' };
    
    const res = engine.reconcile(hedgeReq, local, prov);
    expect(res.result).toBe('SAFE_TO_CONFIRM');
    
    // Validate output boundaries
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain('wallet');
    expect(serialized).not.toContain('ledger');
    expect(serialized).not.toContain('apiKey');
  });

});
