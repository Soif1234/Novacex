/**
 * Phase 9.2 — Custody Abstraction Layer: Provider-Neutral Error Model
 *
 * Follows the project conventions established by `wallet/errors.ts`:
 * - `AppError` base class from `middleware/errorHandler`
 * - typed error code constants
 * - concrete error subclasses for unambiguous catch/throw
 *
 * Provider-specific secret or internal details must never be exposed through
 * these errors to HTTP responses or logs.
 */

import { AppError } from '../../middleware/errorHandler';

// ---------------------------------------------------------------------------
// Error Codes
// ---------------------------------------------------------------------------

export const CustodyErrorCode = {
  CUSTODY_DISABLED: 'CUSTODY_DISABLED',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  UNSUPPORTED_ASSET_NETWORK: 'UNSUPPORTED_ASSET_NETWORK',
  CUSTODY_CAPABILITY_UNAVAILABLE: 'CUSTODY_CAPABILITY_UNAVAILABLE',
  INVALID_CUSTODY_REQUEST: 'INVALID_CUSTODY_REQUEST',
  CUSTODY_TRANSACTION_NOT_FOUND: 'CUSTODY_TRANSACTION_NOT_FOUND',
  CUSTODY_OPERATION_REJECTED: 'CUSTODY_OPERATION_REJECTED',
  SWEEP_DUST: 'SWEEP_DUST',
  SWEEP_ZERO_BALANCE: 'SWEEP_ZERO_BALANCE',
  SWEEP_RECONCILIATION_REQUIRED: 'SWEEP_RECONCILIATION_REQUIRED',
} as const;

export type CustodyErrorCodeType = (typeof CustodyErrorCode)[keyof typeof CustodyErrorCode];

// ---------------------------------------------------------------------------
// Base Error
// ---------------------------------------------------------------------------

export class CustodyError extends AppError {
  constructor(message: string, statusCode: number, code: CustodyErrorCodeType, details?: unknown) {
    super(message, statusCode, code, details);
    this.name = 'CustodyError';
  }
}

// ---------------------------------------------------------------------------
// Concrete Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the custody system is disabled (CUSTODY_ENABLED=false).
 * All CAL operations fail closed with this error.
 */
export class CustodyDisabledError extends CustodyError {
  constructor() {
    super(
      'Custody service is disabled (CUSTODY_ENABLED=false). Enable it only when the real-money custody system is ready.',
      503,
      CustodyErrorCode.CUSTODY_DISABLED,
    );
    this.name = 'CustodyDisabledError';
  }
}

/**
 * The custody provider is unreachable, unhealthy, or returned an unexpected error.
 */
export class ProviderUnavailableError extends CustodyError {
  constructor(providerId: string, detail?: string) {
    super(
      `Custody provider "${providerId}" is unavailable${detail ? `: ${detail}` : ''}`,
      503,
      CustodyErrorCode.PROVIDER_UNAVAILABLE,
      { providerId },
    );
    this.name = 'ProviderUnavailableError';
  }
}

/**
 * The requested (asset, network) is not supported by the custody provider.
 */
export class UnsupportedAssetNetworkError extends CustodyError {
  constructor(asset: string, network: string, providerId?: string) {
    super(
      `Asset/network pair "${asset}/${network}" is not supported${providerId ? ` by provider "${providerId}"` : ''}`,
      400,
      CustodyErrorCode.UNSUPPORTED_ASSET_NETWORK,
      { asset, network, providerId },
    );
    this.name = 'UnsupportedAssetNetworkError';
  }
}

/**
 * The provider does not support the requested capability.
 */
export class CustodyCapabilityUnavailableError extends CustodyError {
  constructor(capability: string, providerId: string) {
    super(
      `Provider "${providerId}" does not support capability "${capability}"`,
      501,
      CustodyErrorCode.CUSTODY_CAPABILITY_UNAVAILABLE,
      { capability, providerId },
    );
    this.name = 'CustodyCapabilityUnavailableError';
  }
}

/**
 * The request was malformed or contained invalid parameters.
 */
export class InvalidCustodyRequestError extends CustodyError {
  constructor(message: string, details?: unknown) {
    super(message, 400, CustodyErrorCode.INVALID_CUSTODY_REQUEST, details);
    this.name = 'InvalidCustodyRequestError';
  }
}

/**
 * A custody transaction or withdrawal was not found.
 */
export class CustodyTransactionNotFoundError extends CustodyError {
  constructor(transactionId: string) {
    super(
      `Custody transaction "${transactionId}" not found`,
      404,
      CustodyErrorCode.CUSTODY_TRANSACTION_NOT_FOUND,
      { transactionId },
    );
    this.name = 'CustodyTransactionNotFoundError';
  }
}

/**
 * The custody provider rejected the operation (e.g. withdrawal policy violation).
 */
export class CustodyOperationRejectedError extends CustodyError {
  constructor(message: string, details?: unknown) {
    super(message, 422, CustodyErrorCode.CUSTODY_OPERATION_REJECTED, details);
    this.name = 'CustodyOperationRejectedError';
  }
}

// ---------------------------------------------------------------------------
// Sweep-specific typed errors (Phase 10.4 Step 6E-4C-2)
//
// These MUST be CustodyError subclasses: the CAL's normalizeError() preserves
// CustodyError instances and wraps everything else into
// ProviderUnavailableError, which would destroy the semantic signal workers
// rely on to route sweep outcomes (dust / zero balance / reconciliation).
// ---------------------------------------------------------------------------

/**
 * The sweep is economically unviable right now. Thrown strictly BEFORE any
 * nonce allocation: a dust sweep must never consume a hot-wallet nonce.
 * The SweepWorker defers the affected pending_sweeps to DEFERRED_DUST.
 */
export class SweepDustError extends CustodyError {
  constructor(asset: string, network: string, detail?: string) {
    super(
      `DUST: sweep deferred — balance for ${asset}/${network} is below the economic sweep threshold${detail ? ` (${detail})` : ''}`,
      409,
      CustodyErrorCode.SWEEP_DUST,
      { asset, network },
    );
    this.name = 'SweepDustError';
  }
}

/**
 * The forwarder's physical balance is zero although pending_sweeps rows exist.
 * Carries the result of the sweep-history investigation:
 * - settledTxHash set: an earlier CONFIRMED sweep already moved this
 *   forwarder's balance — the rows are physically settled and the worker
 *   reconciles them to CONFIRMED with that tx hash.
 * - settledTxHash null: no matching sweep exists — external movement, stale
 *   detection or data corruption; the worker surfaces an explicit
 *   RECONCILIATION state (never a silent terminal success).
 */
export class SweepZeroBalanceError extends CustodyError {
  public readonly settledTxHash: string | null;
  constructor(network: string, address: string, asset: string, settledTxHash: string | null) {
    super(
      settledTxHash
        ? `ZERO_BALANCE (explained): balance for ${asset}/${address} was already moved by confirmed sweep ${settledTxHash}`
        : `ZERO_BALANCE (unexplained): balance for ${asset}/${address} is zero with NO matching sweep history — reconciliation required`,
      409,
      CustodyErrorCode.SWEEP_ZERO_BALANCE,
      { network, address, asset, settledTxHash },
    );
    this.name = 'SweepZeroBalanceError';
    this.settledTxHash = settledTxHash;
  }
}

/**
 * A durable sweep intent holds a reserved nonce that can no longer be safely
 * used (nonce consumed externally, or an unknown transaction is pending at or
 * below the reserved nonce). Manual/operational reconciliation is required.
 * NO further nonce is ever allocated for this intent.
 */
export class SweepReconciliationRequiredError extends CustodyError {
  constructor(intentId: string, nonce: number, reason: string) {
    super(
      `Sweep intent ${intentId} (reserved nonce ${nonce}) requires manual reconciliation: ${reason}`,
      409,
      CustodyErrorCode.SWEEP_RECONCILIATION_REQUIRED,
      { intentId, nonce, reason },
    );
    this.name = 'SweepReconciliationRequiredError';
  }
}