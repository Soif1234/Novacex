/**
 * Wallet Service Skeleton
 * Authoritative wallet balance queries, deposits, withdrawals, and internal transfers.
 * Implementation to be completed in Phase 4 Step 6.
 */

export interface IWalletService {
  getBalances(accountId: string): Promise<Record<string, { available: string; locked: string }>>;
  transfer(accountId: string, fromWallet: 'SPOT' | 'FUTURES', toWallet: 'SPOT' | 'FUTURES', asset: string, amount: string): Promise<void>;
  deposit(accountId: string, asset: string, amount: string, txHash: string): Promise<void>;
  withdraw(accountId: string, asset: string, amount: string, address: string): Promise<void>;
}

export const walletServicePlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_6'
};
