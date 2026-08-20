import { ExecutionStatus } from '../../models/liquidity.model';

export class LiquidityExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LiquidityExecutionError';
  }
}

/**
 * Validates a state transition in the external execution lifecycle.
 * The most critical invariant is that UNKNOWN must strictly transition to RECONCILING
 * and cannot be blindly retried or confirmed.
 */
export function validateStateTransition(current: ExecutionStatus, next: ExecutionStatus): void {
  // Prevent blind retries of UNKNOWN state
  if (current === 'UNKNOWN' && next !== 'RECONCILING') {
    throw new LiquidityExecutionError('UNKNOWN state requires RECONCILING before any other transition');
  }

  // RECONCILING can only resolve to terminal or confirmed states
  if (current === 'RECONCILING') {
    if (!['CONFIRMED', 'FAILED', 'FILLED', 'PARTIALLY_FILLED', 'CANCELLED', 'REJECTED'].includes(next)) {
      throw new LiquidityExecutionError(`Invalid transition from RECONCILING to ${next}`);
    }
  }

  // Terminal states cannot be transitioned away from
  const terminalStates: ExecutionStatus[] = ['FILLED', 'CANCELLED', 'REJECTED', 'FAILED'];
  if (terminalStates.includes(current) && current !== next) {
    throw new LiquidityExecutionError(`Cannot transition from terminal state ${current} to ${next}`);
  }
}
