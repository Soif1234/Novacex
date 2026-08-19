import { AppError } from '../../middleware/errorHandler';

/**
 * Ledger Error Codes
 * Explicit, typed error identifiers for all ledger operations.
 */
export const LedgerErrorCode = {
  INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
  INSUFFICIENT_LOCKED_BALANCE: 'INSUFFICIENT_LOCKED_BALANCE',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  INVALID_ASSET: 'INVALID_ASSET',
  ACCOUNT_NOT_FOUND: 'ACCOUNT_NOT_FOUND',
  LEDGER_ACCOUNT_NOT_FOUND: 'LEDGER_ACCOUNT_NOT_FOUND',
  DUPLICATE_REFERENCE: 'DUPLICATE_REFERENCE',
  REFERENCE_CONFLICT: 'REFERENCE_CONFLICT',
  UNBALANCED_TRANSACTION: 'UNBALANCED_TRANSACTION',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',
  OWNERSHIP_DENIED: 'OWNERSHIP_DENIED',
  WALLET_NOT_FOUND: 'WALLET_NOT_FOUND',
  RECONCILIATION_MISMATCH: 'RECONCILIATION_MISMATCH',
} as const;

export type LedgerErrorCodeType = typeof LedgerErrorCode[keyof typeof LedgerErrorCode];

export class LedgerError extends AppError {
  constructor(message: string, statusCode: number, code: LedgerErrorCodeType, details?: unknown) {
    super(message, statusCode, code, details);
    this.name = 'LedgerError';
  }
}

export class InsufficientBalanceError extends LedgerError {
  constructor(type: 'available' | 'locked', asset: string, requested: string, current: string) {
    super(
      `Insufficient ${type} balance for ${asset}: requested ${requested}, available ${current}`,
      400,
      type === 'available'
        ? LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE
        : LedgerErrorCode.INSUFFICIENT_LOCKED_BALANCE,
      { asset, requested, current }
    );
  }
}

export class InvalidAmountError extends LedgerError {
  constructor(amount: string, reason: string) {
    super(
      `Invalid amount "${amount}": ${reason}`,
      400,
      LedgerErrorCode.INVALID_AMOUNT,
      { amount, reason }
    );
  }
}

export class DuplicateReferenceError extends LedgerError {
  constructor(referenceId: string, accountId: string) {
    super(
      `Duplicate reference: transaction with reference "${referenceId}" already exists for this account`,
      409,
      LedgerErrorCode.DUPLICATE_REFERENCE,
      { referenceId, accountId }
    );
  }
}

export class ReferenceConflictError extends LedgerError {
  constructor(referenceId: string) {
    super(
      `Reference conflict: a transaction with reference "${referenceId}" already exists with different parameters`,
      409,
      LedgerErrorCode.REFERENCE_CONFLICT,
      { referenceId }
    );
  }
}

export class UnbalancedTransactionError extends LedgerError {
  constructor(totalDebits: string, totalCredits: string) {
    super(
      `Unbalanced transaction: total debits (${totalDebits}) do not equal total credits (${totalCredits})`,
      400,
      LedgerErrorCode.UNBALANCED_TRANSACTION,
      { totalDebits, totalCredits }
    );
  }
}
