import { AppError } from '../../middleware/errorHandler';

/**
 * Wallet Error Codes
 * Explicit typed error identifiers for wallet operations.
 */
export const WalletErrorCode = {
  INVALID_ASSET: 'INVALID_ASSET',
  ASSET_DISABLED: 'ASSET_DISABLED',
  EXCESSIVE_DECIMAL_PRECISION: 'EXCESSIVE_DECIMAL_PRECISION',
  INVALID_ACCOUNT_TYPE: 'INVALID_ACCOUNT_TYPE',
  SAME_ACCOUNT_TRANSFER: 'SAME_ACCOUNT_TRANSFER',
  CROSS_USER_TRANSFER_DENIED: 'CROSS_USER_TRANSFER_DENIED',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  ACCOUNT_OWNERSHIP_DENIED: 'ACCOUNT_OWNERSHIP_DENIED',
  INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
  DUPLICATE_REFERENCE: 'DUPLICATE_REFERENCE',
  REFERENCE_CONFLICT: 'REFERENCE_CONFLICT',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  MISSING_PARAMETER: 'MISSING_PARAMETER',
} as const;

export type WalletErrorCodeType = typeof WalletErrorCode[keyof typeof WalletErrorCode];

export class WalletError extends AppError {
  constructor(message: string, statusCode: number, code: WalletErrorCodeType, details?: unknown) {
    super(message, statusCode, code, details);
    this.name = 'WalletError';
  }
}

export class InvalidAssetError extends WalletError {
  constructor(asset: string, reason = 'Asset not recognized in asset registry') {
    super(`Invalid asset "${asset}": ${reason}`, 400, WalletErrorCode.INVALID_ASSET, { asset, reason });
  }
}

export class AssetDisabledError extends WalletError {
  constructor(asset: string) {
    super(`Asset "${asset}" is currently disabled for trading and transfers`, 400, WalletErrorCode.ASSET_DISABLED, { asset });
  }
}

export class ExcessiveDecimalPrecisionError extends WalletError {
  constructor(asset: string, amount: string, maxDecimals: number) {
    super(
      `Excessive decimal precision for ${asset}: amount "${amount}" exceeds maximum allowed precision of ${maxDecimals} decimal places`,
      400,
      WalletErrorCode.EXCESSIVE_DECIMAL_PRECISION,
      { asset, amount, maxDecimals }
    );
  }
}

export class AccountNotFoundError extends WalletError {
  constructor(accountId: string) {
    super(`Account "${accountId}" was not found`, 404, WalletErrorCode.ACCOUNT_NOT_FOUND, { accountId });
  }
}

export class AccountOwnershipDeniedError extends WalletError {
  constructor(accountId: string) {
    super(`Access denied: account "${accountId}" does not belong to the authenticated user`, 403, WalletErrorCode.ACCOUNT_OWNERSHIP_DENIED, { accountId });
  }
}

export class SameAccountTransferError extends WalletError {
  constructor(accountId: string) {
    super(`Source and destination accounts cannot be the same (${accountId})`, 400, WalletErrorCode.SAME_ACCOUNT_TRANSFER, { accountId });
  }
}

export class CrossUserTransferDeniedError extends WalletError {
  constructor() {
    super('Internal transfers are restricted to accounts owned by the same authenticated user', 403, WalletErrorCode.CROSS_USER_TRANSFER_DENIED);
  }
}
