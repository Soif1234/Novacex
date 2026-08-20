import { ProviderError, ProviderErrorCode } from './errors';
import { ExecutionStatus } from '../../models/liquidity.model';
import * as crypto from 'crypto';

export type RetryDecisionType = 
  | 'RETRY' 
  | 'BLOCK_RETRY' 
  | 'RECONCILE_FIRST' 
  | 'NO_RETRY' 
  | 'MANUAL_REVIEW' 
  | 'IDEMPOTENT_DUPLICATE';

export interface RetryDecision {
  type: RetryDecisionType;
  delayMs: number;
  reason: string;
  idempotencyKey: string;
  timestamp: number;
}

export interface RetryPolicy {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors: Set<ProviderErrorCode>;
}

export interface FailureContext {
  clientOrderId: string;
  providerId: string;
  attempt: number;
  state: ExecutionStatus;
  errorCode: ProviderErrorCode;
  timestamp: number;
  reconciliationRequired: boolean;
  submissionConfirmed: boolean;
}

export class RetryEngine {
  // In-memory idempotency guard against concurrent retries and duplicates
  private retryTracker: Map<string, RetryDecision> = new Map();

  public evaluate(context: FailureContext, policy: RetryPolicy): RetryDecision {
    this.validateInputs(context, policy);

    const idempotencyKey = this.generateIdempotencyKey(context);
    
    // 6. Duplicate Submission Protection
    if (this.retryTracker.has(idempotencyKey)) {
      const cached = this.retryTracker.get(idempotencyKey)!;
      return this.decision('IDEMPOTENT_DUPLICATE', 0, 'Duplicate logical retry attempt', idempotencyKey);
    }

    const decision = this.computeDecision(context, policy, idempotencyKey);
    this.retryTracker.set(idempotencyKey, decision);
    return decision;
  }

  private computeDecision(context: FailureContext, policy: RetryPolicy, idempotencyKey: string): RetryDecision {
    // 4. UNKNOWN Safety & Reconciling blocks
    if (context.state === 'UNKNOWN' || context.reconciliationRequired) {
      return this.decision('RECONCILE_FIRST', 0, 'UNKNOWN state or reconciliation required', idempotencyKey);
    }
    if (context.state === 'RECONCILING') {
      return this.decision('BLOCK_RETRY', 0, 'Currently reconciling', idempotencyKey);
    }

    // Terminal/Confirmed states
    if (context.state === 'FILLED' || context.state === 'CANCELLED' || context.state === 'REJECTED' || context.state === 'FAILED') {
      return this.decision('NO_RETRY', 0, `Terminal state: ${context.state}`, idempotencyKey);
    }

    // 13. Partial Fills - can't blind retry
    if (context.state === 'PARTIALLY_FILLED') {
      return this.decision('BLOCK_RETRY', 0, 'Partial fill requires precise residual slice calculation', idempotencyKey);
    }

    // 10. Timeout Semantics
    if (context.errorCode === ProviderErrorCode.TIMEOUT) {
      if (context.submissionConfirmed) {
        // Timeout AFTER submission is UNKNOWN
        return this.decision('RECONCILE_FIRST', 0, 'Timeout after submission requires reconciliation', idempotencyKey);
      }
      // Timeout BEFORE submission is retryable if in policy
      if (!policy.retryableErrors.has(ProviderErrorCode.TIMEOUT)) {
        return this.decision('NO_RETRY', 0, 'Timeout not retryable by policy', idempotencyKey);
      }
    }

    // Specific error non-retryable hardcodes
    if (
      context.errorCode === ProviderErrorCode.AUTHENTICATION_FAILURE ||
      context.errorCode === ProviderErrorCode.AUTHORIZATION_FAILURE ||
      context.errorCode === ProviderErrorCode.INVALID_REQUEST ||
      context.errorCode === ProviderErrorCode.ORDER_REJECTED ||
      context.errorCode === ProviderErrorCode.UNSUPPORTED_OPERATION ||
      context.errorCode === ProviderErrorCode.INSUFFICIENT_BALANCE
    ) {
      return this.decision('NO_RETRY', 0, 'Non-retryable error category', idempotencyKey);
    }

    if (!policy.retryableErrors.has(context.errorCode)) {
       return this.decision('NO_RETRY', 0, 'Error not in retryable policy set', idempotencyKey);
    }

    // 7. Retry Counters
    if (context.attempt >= policy.maxAttempts) {
       return this.decision('MANUAL_REVIEW', 0, `Max attempts (${policy.maxAttempts}) reached`, idempotencyKey);
    }

    // 8. Exponential Backoff
    const delay = this.calculateBackoff(context.attempt, policy);
    return this.decision('RETRY', delay, 'Retry conditions met', idempotencyKey);
  }

  private calculateBackoff(attempt: number, policy: RetryPolicy): number {
    // Ensure attempt starts at 1 for calculation
    const calcAttempt = Math.max(1, attempt);
    let delay = policy.initialDelayMs * Math.pow(policy.backoffMultiplier, calcAttempt - 1);
    
    if (policy.jitter) {
      // Jitter +/- 20% deterministically pseudo-random or random. We'll use random for standard jitter
      const jitterFactor = 0.8 + (Math.random() * 0.4);
      delay = delay * jitterFactor;
    }

    return Math.floor(Math.min(delay, policy.maxDelayMs));
  }

  private generateIdempotencyKey(context: FailureContext): string {
    const raw = `retry:${context.providerId}:${context.clientOrderId}:${context.attempt}:${context.errorCode}`;
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private decision(type: RetryDecisionType, delayMs: number, reason: string, idempotencyKey: string): RetryDecision {
    return {
      type,
      delayMs,
      reason,
      idempotencyKey,
      timestamp: Date.now()
    };
  }

  private validateInputs(context: FailureContext, policy: RetryPolicy) {
    if (context.attempt < 0 || !isFinite(context.attempt)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid attempt counter', 'RETRY');
    }
    if (policy.initialDelayMs < 0 || !isFinite(policy.initialDelayMs)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid initialDelayMs', 'RETRY');
    }
    if (policy.maxDelayMs < 0 || !isFinite(policy.maxDelayMs)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid maxDelayMs', 'RETRY');
    }
    if (policy.backoffMultiplier < 0 || !isFinite(policy.backoffMultiplier)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid backoffMultiplier', 'RETRY');
    }
    if (policy.maxAttempts < 0 || !isFinite(policy.maxAttempts)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid maxAttempts', 'RETRY');
    }
    if (!context.clientOrderId || !context.providerId) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Missing deterministic identifiers', 'RETRY');
    }
  }

  public resetTracker() {
    this.retryTracker.clear();
  }
}
