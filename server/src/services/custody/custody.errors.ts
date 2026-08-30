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