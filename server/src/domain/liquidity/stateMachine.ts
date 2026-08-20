import { ExecutionStatus } from '../../models/liquidity.model';
import { ProviderError, ProviderErrorCode } from './errors';

export type ReconciliationOutcome = 
  | 'STILL_UNKNOWN'
  | 'NOT_FOUND'
  | 'OPEN'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED';

export interface ExecutionStateEvent {
  executionId: string;
  newState: ExecutionStatus;
  sequence: number;
  timestamp: number;
  filledQuantity?: string;
  averagePrice?: string;
  fee?: string;
  feeAsset?: string;
  reconciliationOutcome?: ReconciliationOutcome;
}

export interface ExecutionStateData {
  executionId: string;
  status: ExecutionStatus;
  requestedQuantity: string;
  filledQuantity: string;
  remainingQuantity: string;
  lastSequence: number;
}

const TERMINAL_STATES = new Set<ExecutionStatus>(['FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'CONFIRMED']);

const VALID_TRANSITIONS: Record<ExecutionStatus, Set<ExecutionStatus>> = {
  CREATED: new Set(['VALIDATED', 'FAILED', 'REJECTED']),
  VALIDATED: new Set(['RESERVED', 'FAILED', 'CANCELLED']),
  RESERVED: new Set(['ROUTING', 'FAILED', 'CANCELLED']),
  ROUTING: new Set(['SUBMITTED', 'FAILED']),
  SUBMITTED: new Set(['ACKNOWLEDGED', 'FAILED', 'UNKNOWN', 'REJECTED']),
  ACKNOWLEDGED: new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'REJECTED', 'UNKNOWN']),
  PARTIALLY_FILLED: new Set(['PARTIALLY_FILLED', 'FILLED', 'CANCEL_PENDING', 'UNKNOWN']),
  CANCEL_PENDING: new Set(['CANCELLED', 'UNKNOWN', 'FILLED', 'PARTIALLY_FILLED']),
  UNKNOWN: new Set(['RECONCILING']),
  RECONCILING: new Set(['RECONCILING', 'ACKNOWLEDGED', 'PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'FAILED', 'UNKNOWN']),
  FILLED: new Set(['CONFIRMED']),
  CANCELLED: new Set(['CONFIRMED']),
  REJECTED: new Set(['CONFIRMED']),
  FAILED: new Set(['CONFIRMED']),
  CONFIRMED: new Set()
};

export class ExecutionStateMachine {

  public static isTerminal(status: ExecutionStatus): boolean {
    return TERMINAL_STATES.has(status);
  }

  public static canRetry(status: ExecutionStatus): boolean {
    // Retry is allowed only when state proves external submission was never accepted/submitted.
    // E.g., if FAILED at routing, or VALIDATED. Never if SUBMITTED, ACKNOWLEDGED, PARTIALLY_FILLED, or UNKNOWN.
    if (status === 'UNKNOWN' || status === 'SUBMITTED' || status === 'ACKNOWLEDGED' || status === 'PARTIALLY_FILLED' || status === 'RECONCILING') {
      return false;
    }
    return status === 'FAILED' || status === 'REJECTED' || status === 'CREATED' || status === 'VALIDATED';
  }

  public static isValidTransition(from: ExecutionStatus, to: ExecutionStatus): boolean {
    if (from === to && from === 'PARTIALLY_FILLED') return true;
    if (from === to && from === 'RECONCILING') return true;
    return VALID_TRANSITIONS[from]?.has(to) || false;
  }

  public static applyEvent(currentData: ExecutionStateData, event: ExecutionStateEvent): ExecutionStateData {
    if (event.executionId !== currentData.executionId) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Event executionId ${event.executionId} does not match current ${currentData.executionId}`, 'STATE_MACHINE');
    }

    if (event.sequence < currentData.lastSequence) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Stale event sequence: ${event.sequence} < ${currentData.lastSequence}`, 'STATE_MACHINE');
    }

    if (event.sequence === currentData.lastSequence) {
      // Idempotency check: if the event exactly matches the resulting state, we can silently return (ignore).
      // If it's a conflicting event on the same sequence, reject it.
      if (currentData.status === event.newState) {
         if (event.filledQuantity !== undefined && Number(event.filledQuantity) !== Number(currentData.filledQuantity)) {
            throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Conflicting duplicate sequence: filledQty differs`, 'STATE_MACHINE');
         }
         return { ...currentData }; // Idempotent success
      }
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Conflicting duplicate sequence: ${event.sequence} with different state ${event.newState}`, 'STATE_MACHINE');
    }

    if (!this.isValidTransition(currentData.status, event.newState)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Invalid state transition from ${currentData.status} to ${event.newState}`, 'STATE_MACHINE');
    }

    const requestedQty = Number(currentData.requestedQuantity);
    let currentFilledQty = Number(currentData.filledQuantity);
    
    let newFilledQty = currentFilledQty;
    if (event.filledQuantity !== undefined) {
      newFilledQty = Number(event.filledQuantity);
      if (isNaN(newFilledQty) || newFilledQty < 0) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Invalid filled quantity: ${event.filledQuantity}`, 'STATE_MACHINE');
      }
      if (newFilledQty < currentFilledQty) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Filled quantity cannot decrease: ${currentFilledQty} -> ${newFilledQty}`, 'STATE_MACHINE');
      }
      if (newFilledQty > requestedQty) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Overfill rejection: ${newFilledQty} > ${requestedQty}`, 'STATE_MACHINE');
      }
    }

    // Additional invariants
    if (event.averagePrice !== undefined) {
      const price = Number(event.averagePrice);
      if (isNaN(price) || price < 0) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Invalid average price: ${event.averagePrice}`, 'STATE_MACHINE');
      }
    }

    // UNKNOWN -> RECONCILING rules
    if (currentData.status === 'UNKNOWN' && event.newState !== 'RECONCILING') {
       throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `UNKNOWN must transition to RECONCILING`, 'STATE_MACHINE');
    }

    // RECONCILING output rules
    if (currentData.status === 'RECONCILING') {
      if (!event.reconciliationOutcome && event.newState !== 'RECONCILING') {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Transition from RECONCILING requires an authoritative outcome`, 'STATE_MACHINE');
      }
      if (event.reconciliationOutcome === 'STILL_UNKNOWN' && event.newState !== 'RECONCILING') {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `STILL_UNKNOWN outcome must map to RECONCILING state`, 'STATE_MACHINE');
      }
    }

    return {
      executionId: currentData.executionId,
      status: event.newState,
      requestedQuantity: currentData.requestedQuantity,
      filledQuantity: newFilledQty.toFixed(8),
      remainingQuantity: Math.max(0, requestedQty - newFilledQty).toFixed(8),
      lastSequence: event.sequence
    };
  }
}
