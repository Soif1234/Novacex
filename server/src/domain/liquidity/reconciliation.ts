import { ProviderError, ProviderErrorCode } from './errors';
import { ExecutionStatus } from '../../models/liquidity.model';
import { ExecutionEconomics } from './economics';
import * as crypto from 'crypto';

export type ReconciliationResult = 
  | 'MATCHED'
  | 'PROVIDER_AHEAD'
  | 'LOCAL_AHEAD'
  | 'QUANTITY_MISMATCH'
  | 'STATUS_MISMATCH'
  | 'PRICE_MISMATCH'
  | 'FEE_MISMATCH'
  | 'UNKNOWN_PROVIDER_STATE'
  | 'UNKNOWN_LOCAL_STATE'
  | 'PROVIDER_ORDER_MISSING'
  | 'LOCAL_ORDER_MISSING'
  | 'DUPLICATE_FILL'
  | 'RECONCILIATION_REQUIRED'
  | 'SAFE_TO_CONFIRM'
  | 'SAFE_TO_CANCEL'
  | 'MANUAL_REVIEW'
  | 'INVALID_RECONCILIATION_DATA';

export type ReconciliationAction = 
  | 'NO_ACTION'
  | 'CONFIRM_EXECUTION'
  | 'UPDATE_EXECUTION_STATE'
  | 'UPDATE_PARTIAL_FILL'
  | 'CANCEL_EXECUTION'
  | 'RETRY_RECONCILIATION'
  | 'MANUAL_REVIEW'
  | 'BLOCK_RETRY';

export interface ReconciliationRequest {
  reconciliationId: string;
  providerId: string;
  venueId: string;
  clientOrderId: string;
  providerOrderId: string;
  symbol: string;
  requestedQuantity: string;
  requestedSide: 'BUY' | 'SELL';
  localState: ExecutionStatus;
  lastKnownProviderState: ExecutionStatus;
  timestamp: number;
}

export interface ProviderExecutionSnapshot {
  providerId: string;
  providerOrderId: string;
  clientOrderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  requestedQuantity: string;
  executedQuantity: string;
  remainingQuantity: string;
  averageExecutionPrice: string;
  fees: string;
  status: ExecutionStatus;
  sequence: number;
  timestamp: number;
}

export interface LocalExecutionSnapshot {
  clientOrderId: string;
  executionState: ExecutionStatus;
  requestedQuantity: string;
  executedQuantity: string;
  remainingQuantity: string;
  averageExecutionPrice: string;
  economics?: ExecutionEconomics;
  sequence: number;
}

export interface ReconciliationDecision {
  result: ReconciliationResult;
  action: ReconciliationAction;
  reason: string;
  fingerprint: string;
  timestamp: number;
}

export class ReconciliationEngine {
  
  // To protect against duplicate fills during a runtime session (sequence checks)
  private sequenceTracker: Map<string, { seq: number, fingerprint: string }> = new Map();

  public reconcile(
    req: ReconciliationRequest,
    local: LocalExecutionSnapshot | null,
    provider: ProviderExecutionSnapshot | null
  ): ReconciliationDecision {
    const timestamp = Date.now();
    const fStr = `${req.reconciliationId}:${req.clientOrderId}:${provider?.sequence || 'missing'}:${provider?.status || 'missing'}:${provider?.executedQuantity || '0'}:${provider?.remainingQuantity || '0'}`;
    const fingerprint = crypto.createHash('sha256').update(fStr).digest('hex');

    try {
      this.validateInputs(req, local, provider);

      if (!local) {
        return this.decision('LOCAL_ORDER_MISSING', 'MANUAL_REVIEW', 'Local order state not found for reconciliation', fingerprint);
      }

      if (!provider) {
        if (local.executionState === 'UNKNOWN' || local.executionState === 'SUBMITTED') {
          return this.decision('PROVIDER_ORDER_MISSING', 'RETRY_RECONCILIATION', 'Provider lookup found no corresponding order', fingerprint);
        }
        return this.decision('PROVIDER_ORDER_MISSING', 'MANUAL_REVIEW', 'Provider order missing in non-pending state', fingerprint);
      }

      if (provider.status === 'UNKNOWN') {
        return this.decision('UNKNOWN_PROVIDER_STATE', 'RETRY_RECONCILIATION', 'Provider API returned UNKNOWN state', fingerprint);
      }
      
      // Sequence check
      const seqKey = `${provider.providerId}:${provider.clientOrderId}`;
      const lastSeq = this.sequenceTracker.get(seqKey);
      
      if (lastSeq) {
        if (provider.sequence < lastSeq.seq) {
          return this.decision('INVALID_RECONCILIATION_DATA', 'BLOCK_RETRY', 'Stale provider sequence rejected', fingerprint);
        }
        if (provider.sequence === lastSeq.seq && fingerprint !== lastSeq.fingerprint) {
           return this.decision('INVALID_RECONCILIATION_DATA', 'BLOCK_RETRY', 'Conflicting data on identical sequence', fingerprint);
        }
        if (provider.sequence === lastSeq.seq && fingerprint === lastSeq.fingerprint) {
           // Idempotency: exact duplicate snapshot -> no action
           return this.decision('MATCHED', 'NO_ACTION', 'Idempotent identical sequence snapshot', fingerprint);
        }
      }

      // Quantity mismatch check
      const provReqQty = Number(provider.requestedQuantity);
      const provExecQty = Number(provider.executedQuantity);
      const provRemQty = Number(provider.remainingQuantity);
      const localReqQty = Number(local.requestedQuantity);

      if (provReqQty !== localReqQty) {
        return this.decision('QUANTITY_MISMATCH', 'MANUAL_REVIEW', 'Requested quantities do not match', fingerprint);
      }

      // Check UNKNOWN local resolution
      if (local.executionState === 'UNKNOWN' || local.executionState === 'RECONCILING') {
         if (provider.status === 'FILLED') {
            this.sequenceTracker.set(seqKey, { seq: provider.sequence, fingerprint });
            return this.decision('SAFE_TO_CONFIRM', 'CONFIRM_EXECUTION', 'Safe to resolve UNKNOWN into FILLED', fingerprint);
         }
         if (provider.status === 'CANCELLED') {
            this.sequenceTracker.set(seqKey, { seq: provider.sequence, fingerprint });
            return this.decision('SAFE_TO_CANCEL', 'CANCEL_EXECUTION', 'Safe to resolve UNKNOWN into CANCELLED', fingerprint);
         }
         if (provider.status === 'PARTIALLY_FILLED') {
            this.sequenceTracker.set(seqKey, { seq: provider.sequence, fingerprint });
            return this.decision('SAFE_TO_CONFIRM', 'UPDATE_PARTIAL_FILL', 'Safe to resolve UNKNOWN into PARTIALLY_FILLED', fingerprint);
         }
      }

      // Downgrade protection
      if (local.executionState === 'FILLED' && provider.status !== 'FILLED') {
         return this.decision('STATUS_MISMATCH', 'MANUAL_REVIEW', 'Provider attempts to downgrade a locally FILLED order', fingerprint);
      }

      // Status mismatches
      if (local.executionState !== provider.status) {
         if (['CREATED', 'SUBMITTED', 'ROUTING', 'ACKNOWLEDGED', 'VALIDATED', 'RESERVED'].includes(local.executionState)) {
             // Provider ahead
             this.sequenceTracker.set(seqKey, { seq: provider.sequence, fingerprint });
             if (provider.status === 'FILLED') return this.decision('PROVIDER_AHEAD', 'CONFIRM_EXECUTION', 'Provider ahead, resolving to FILLED', fingerprint);
             if (provider.status === 'CANCELLED') return this.decision('PROVIDER_AHEAD', 'CANCEL_EXECUTION', 'Provider ahead, resolving to CANCELLED', fingerprint);
             if (provider.status === 'PARTIALLY_FILLED') return this.decision('PROVIDER_AHEAD', 'UPDATE_PARTIAL_FILL', 'Provider ahead, resolving to PARTIAL', fingerprint);
             if (provider.status === 'REJECTED' || provider.status === 'FAILED') return this.decision('PROVIDER_AHEAD', 'CANCEL_EXECUTION', 'Provider ahead, resolving to REJECTED/FAILED', fingerprint);
             return this.decision('PROVIDER_AHEAD', 'UPDATE_EXECUTION_STATE', 'Provider ahead, safe status update', fingerprint);
         }
         return this.decision('STATUS_MISMATCH', 'MANUAL_REVIEW', 'Unresolvable status discrepancy', fingerprint);
      }

      // Price / Fee Mismatch
      if (local.averageExecutionPrice && Number(local.averageExecutionPrice) > 0 && provider.averageExecutionPrice !== '0') {
         const lPrice = Number(local.averageExecutionPrice);
         const pPrice = Number(provider.averageExecutionPrice);
         // Simplified strict check. In reality, a tolerance might be configured.
         if (Math.abs(lPrice - pPrice) > Number.EPSILON) {
            return this.decision('PRICE_MISMATCH', 'MANUAL_REVIEW', 'Execution price mismatch', fingerprint);
         }
      }

      // Fully matched identically
      this.sequenceTracker.set(seqKey, { seq: provider.sequence, fingerprint });
      return this.decision('MATCHED', 'NO_ACTION', 'Local and Provider perfectly matched', fingerprint);
      
    } catch (e: any) {
      if (e instanceof ProviderError) {
         return this.decision('INVALID_RECONCILIATION_DATA', 'BLOCK_RETRY', e.message, fingerprint);
      }
      return this.decision('INVALID_RECONCILIATION_DATA', 'MANUAL_REVIEW', 'Unhandled reconciliation error', fingerprint);
    }
  }

  private validateInputs(req: ReconciliationRequest, local: LocalExecutionSnapshot | null, provider: ProviderExecutionSnapshot | null) {
    if (provider) {
       const reqQty = Number(provider.requestedQuantity);
       const execQty = Number(provider.executedQuantity);
       const remQty = Number(provider.remainingQuantity);
       const avgPrice = Number(provider.averageExecutionPrice);
       const fees = Number(provider.fees);

       if (!isFinite(reqQty) || reqQty < 0) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid provider requestedQuantity', 'RECONCILIATION');
       if (!isFinite(execQty) || execQty < 0) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid provider executedQuantity', 'RECONCILIATION');
       if (!isFinite(remQty) || remQty < 0) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid provider remainingQuantity', 'RECONCILIATION');
       if (!isFinite(avgPrice) || avgPrice < 0) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid provider averageExecutionPrice', 'RECONCILIATION');
       if (!isFinite(fees) || fees < 0) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid provider fees', 'RECONCILIATION');
       if (execQty > reqQty) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Provider executedQuantity > requestedQuantity (Overfill)', 'RECONCILIATION');
       if (remQty > reqQty) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Provider remainingQuantity > requestedQuantity', 'RECONCILIATION');
       
       // Tolerance for float math: if (exec + rem > req)
       if (execQty + remQty > reqQty + Number.EPSILON) {
         throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Provider executed + remaining > requested', 'RECONCILIATION');
       }
    }

    if (local) {
       const lreqQty = Number(local.requestedQuantity);
       if (!isFinite(lreqQty) || lreqQty < 0) throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid local requestedQuantity', 'RECONCILIATION');
    }
  }

  private decision(result: ReconciliationResult, action: ReconciliationAction, reason: string, fingerprint: string): ReconciliationDecision {
    return {
      result,
      action,
      reason,
      fingerprint,
      timestamp: Date.now()
    };
  }

  public getSequenceState(providerId: string, clientOrderId: string) {
    return this.sequenceTracker.get(`${providerId}:${clientOrderId}`);
  }
  
  public reset() {
    this.sequenceTracker.clear();
  }
}
