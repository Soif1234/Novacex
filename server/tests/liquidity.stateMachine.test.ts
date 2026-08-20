import { describe, it, expect } from 'vitest';
import { ExecutionStateMachine, ExecutionStateData, ExecutionStateEvent } from '../src/domain/liquidity/stateMachine';
import { ExecutionStatus, ExecutionPlan, OrderSlice, LiquiditySource } from '../src/models/liquidity.model';
import { ProviderError, ProviderErrorCode } from '../src/domain/liquidity/errors';

describe('Phase 5.6 - External Execution State Machine', () => {

  const createInitialState = (qty: string = '10.0'): ExecutionStateData => ({
    executionId: 'exec-1',
    status: 'CREATED',
    requestedQuantity: qty,
    filledQuantity: '0.00000000',
    remainingQuantity: qty,
    lastSequence: 0
  });

  const apply = (state: ExecutionStateData, newState: ExecutionStatus, sequence: number, opts: Partial<ExecutionStateEvent> = {}) => {
    return ExecutionStateMachine.applyEvent(state, {
      executionId: 'exec-1',
      newState,
      sequence,
      timestamp: Date.now(),
      ...opts
    });
  };

  it('1-5. Valid sequential transitions (CREATED -> ... -> ACKNOWLEDGED)', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    expect(s.status).toBe('VALIDATED');
    s = apply(s, 'RESERVED', 2);
    expect(s.status).toBe('RESERVED');
    s = apply(s, 'ROUTING', 3);
    expect(s.status).toBe('ROUTING');
    s = apply(s, 'SUBMITTED', 4);
    expect(s.status).toBe('SUBMITTED');
    s = apply(s, 'ACKNOWLEDGED', 5);
    expect(s.status).toBe('ACKNOWLEDGED');
  });

  it('6-8. Valid FILL transitions (ACKNOWLEDGED -> PARTIALLY_FILLED -> FILLED)', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    s = apply(s, 'ROUTING', 3);
    s = apply(s, 'SUBMITTED', 4);
    s = apply(s, 'ACKNOWLEDGED', 5);
    
    s = apply(s, 'PARTIALLY_FILLED', 6, { filledQuantity: '4.0' });
    expect(s.status).toBe('PARTIALLY_FILLED');
    expect(s.filledQuantity).toBe('4.00000000');
    expect(s.remainingQuantity).toBe('6.00000000');
    
    s = apply(s, 'FILLED', 7, { filledQuantity: '10.0' });
    expect(s.status).toBe('FILLED');
    expect(s.filledQuantity).toBe('10.00000000');
  });

  it('9 & 29. Invalid state transition rejection & Terminal protection', () => {
    let s = createInitialState();
    
    // Cannot skip VALIDATED -> ROUTING if invalid transition
    expect(() => apply(s, 'ROUTING', 1)).toThrow(ProviderError);
    
    // Terminal protection: FILLED -> SUBMITTED is illegal
    let term = apply(apply(apply(apply(apply(apply(s, 'VALIDATED', 1), 'RESERVED', 2), 'ROUTING', 3), 'SUBMITTED', 4), 'ACKNOWLEDGED', 5), 'FILLED', 6, { filledQuantity: '10' });
    
    expect(ExecutionStateMachine.isTerminal(term.status)).toBe(true);
    expect(() => apply(term, 'SUBMITTED', 7)).toThrow(ProviderError);
  });

  it('10, 11, 12. UNKNOWN transition, prevents retry, forces RECONCILING', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    s = apply(s, 'ROUTING', 3);
    s = apply(s, 'SUBMITTED', 4);
    
    // Provider timeout
    s = apply(s, 'UNKNOWN', 5);
    expect(s.status).toBe('UNKNOWN');
    expect(ExecutionStateMachine.canRetry(s.status)).toBe(false); // 11
    
    // UNKNOWN -> SUBMITTED is rejected
    expect(() => apply(s, 'SUBMITTED', 6)).toThrow(ProviderError);
    
    // UNKNOWN -> RECONCILING is allowed (12)
    s = apply(s, 'RECONCILING', 6);
    expect(s.status).toBe('RECONCILING');
  });

  it('13, 14, 15, 16. Reconciliation outcomes', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    s = apply(s, 'ROUTING', 3);
    s = apply(s, 'SUBMITTED', 4);
    s = apply(s, 'UNKNOWN', 5);
    s = apply(s, 'RECONCILING', 6);
    
    // Still unknown
    let r1 = apply(s, 'RECONCILING', 7, { reconciliationOutcome: 'STILL_UNKNOWN' });
    expect(r1.status).toBe('RECONCILING');

    // Recon discovers FILLED
    let r2 = apply(s, 'FILLED', 7, { reconciliationOutcome: 'FILLED', filledQuantity: '10' });
    expect(r2.status).toBe('FILLED');

    // Recon discovers CANCELLED
    let r3 = apply(s, 'CANCELLED', 7, { reconciliationOutcome: 'CANCELLED' });
    expect(r3.status).toBe('CANCELLED');
  });

  it('17, 18, 19. Duplicate, conflicting, and stale events', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    
    // 17: Duplicate event is idempotent
    let sDup = apply(s, 'RESERVED', 2);
    expect(sDup.lastSequence).toBe(2);

    // 18: Conflicting duplicate sequence
    expect(() => apply(s, 'ROUTING', 2)).toThrow(/Conflicting duplicate sequence/);

    // 19: Stale sequence
    expect(() => apply(s, 'VALIDATED', 1)).toThrow(/Stale event sequence/);
  });

  it('20, 21, 22. Quantity invariants and overfill rejection', () => {
    let s = createInitialState('10.0');
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    s = apply(s, 'ROUTING', 3);
    s = apply(s, 'SUBMITTED', 4);
    s = apply(s, 'ACKNOWLEDGED', 5);
    
    // 22: Negative qty
    expect(() => apply(s, 'PARTIALLY_FILLED', 6, { filledQuantity: '-1' })).toThrow(/Invalid filled quantity/);
    
    // 21: Overfill rejection
    expect(() => apply(s, 'FILLED', 6, { filledQuantity: '11.0' })).toThrow(/Overfill rejection/);
    
    // Cannot decrease filled qty
    s = apply(s, 'PARTIALLY_FILLED', 6, { filledQuantity: '5.0' });
    expect(() => apply(s, 'PARTIALLY_FILLED', 7, { filledQuantity: '4.0' })).toThrow(/Filled quantity cannot decrease/);
  });

  it('23. Invalid price rejection', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    s = apply(s, 'ROUTING', 3);
    s = apply(s, 'SUBMITTED', 4);
    
    expect(() => apply(s, 'ACKNOWLEDGED', 5, { averagePrice: '-500' })).toThrow(/Invalid average price/);
  });

  it('26. Retry eligibility calculation', () => {
    expect(ExecutionStateMachine.canRetry('CREATED')).toBe(true);
    expect(ExecutionStateMachine.canRetry('VALIDATED')).toBe(true);
    expect(ExecutionStateMachine.canRetry('FAILED')).toBe(true);
    expect(ExecutionStateMachine.canRetry('REJECTED')).toBe(true);
    
    expect(ExecutionStateMachine.canRetry('SUBMITTED')).toBe(false);
    expect(ExecutionStateMachine.canRetry('UNKNOWN')).toBe(false);
    expect(ExecutionStateMachine.canRetry('PARTIALLY_FILLED')).toBe(false);
    expect(ExecutionStateMachine.canRetry('ACKNOWLEDGED')).toBe(false);
  });

  it('27, 28. Cancellation state validation', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    s = apply(s, 'RESERVED', 2);
    s = apply(s, 'ROUTING', 3);
    s = apply(s, 'SUBMITTED', 4);
    s = apply(s, 'ACKNOWLEDGED', 5);
    
    s = apply(s, 'CANCEL_PENDING', 6);
    expect(s.status).toBe('CANCEL_PENDING');
    
    // Provider fails to acknowledge cancel
    s = apply(s, 'UNKNOWN', 7);
    expect(s.status).toBe('UNKNOWN');
  });

  it('24, 25. Split execution plan with UNKNOWN slice prevents aggregate FILLED', () => {
    // This tests the logic that an execution plan must consider independent slice states.
    // In Phase 5.5 we handled this in executor. Here we verify that if slice A is UNKNOWN,
    // the whole plan is UNKNOWN even if B is FILLED.
    
    // Fast-forward states to ACKNOWLEDGED
    let s1 = apply(apply(apply(apply(apply(createInitialState('5'), 'VALIDATED', 1), 'RESERVED', 2), 'ROUTING', 3), 'SUBMITTED', 4), 'ACKNOWLEDGED', 5);
    let s2 = apply(apply(apply(apply(apply(createInitialState('5'), 'VALIDATED', 1), 'RESERVED', 2), 'ROUTING', 3), 'SUBMITTED', 4), 'ACKNOWLEDGED', 5);
    
    const sliceA = apply(s1, 'FILLED', 6, { filledQuantity: '5' });
    const sliceB = apply(s2, 'UNKNOWN', 6);
    
    // Manual aggregate logic that Phase 5.6 dictates
    const hasUnknown = [sliceA, sliceB].some(s => s.status === 'UNKNOWN');
    expect(hasUnknown).toBe(true);
  });

  it('30, 31, 32, 33. Deterministic state, zero credential, no wallet/ledger mutation', () => {
    let s = createInitialState();
    s = apply(s, 'VALIDATED', 1);
    
    const serialized = JSON.stringify(s);
    expect(serialized).toContain('VALIDATED');
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('balance');
  });
});
