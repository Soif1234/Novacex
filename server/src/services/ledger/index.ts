/**
 * Ledger Service Skeleton
 * Authoritative double-entry ledger engine with ACID row-level locking.
 * Implementation to be completed in Phase 4 Step 5.
 */

export interface ILedgerService {
  credit(accountId: string, asset: string, amount: string, referenceId: string, description: string): Promise<void>;
  debit(accountId: string, asset: string, amount: string, referenceId: string, description: string): Promise<void>;
  lockFunds(accountId: string, asset: string, amount: string, referenceId: string): Promise<void>;
  releaseFunds(accountId: string, asset: string, amount: string, referenceId: string): Promise<void>;
  getBalance(accountId: string, asset: string): Promise<{ available: string; locked: string }>;
}

export const ledgerServicePlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_5'
};
