/**
 * Phase 9.2 — Custody Abstraction Layer: Provider-Neutral Adapter Contract
 *
 * Mirrors the spirit of `domain/liquidity/adapter.ts` (ILiquidityProviderAdapter)
 * but for the CUSTODY domain. Any real custody provider (Fireblocks-class,
 * BitGo, Copper, ...) must implement this interface so it can be swapped in
 * without touching the CAL, ledger, wallet, or trading engine.
 *
 * READ operations (health, lookups, balances) are separated conceptually from
 * WRITE operations (withdrawal request). In Phase 9.2 only the MOCK provider
 * exists and no operation touches a real blockchain or any NovaCEX financial
 * state. Write operations are additionally capability-gated by the CAL.
 */

import {
  CustodyAccount,
  CustodyAssetNetwork,
  CustodyBalance,
  CustodyProviderCapability,
  CustodyProviderHealth,
  CustodyTransaction,
  CustodyTransactionStatus,
  DepositAddress,
  WithdrawalRequest,
} from './custody.types';

// ---------------------------------------------------------------------------
// Read Operations
// ---------------------------------------------------------------------------

export interface ICustodyReadAdapter {
  readonly providerId: string;

  /** Advertised capabilities of this provider. */
  getCapabilities(): CustodyProviderCapability[];
  hasCapability(capability: CustodyProviderCapability): boolean;

  /** Provider health/status (no side effects). */
  healthCheck(): Promise<CustodyProviderHealth>;

  /** List (asset, network) pairs the provider supports. */
  getSupportedAssetNetworks(): Promise<CustodyAssetNetwork[]>;

  /** Custody-side accounts/workspaces known to the provider. */
  getAccounts(): Promise<CustodyAccount[]>;

  /** Balances held at the provider (ON-CHAIN reserves, never user wallet rows). */
  getBalances(accountId?: string): Promise<CustodyBalance[]>;

  /** Look up (or create-once) a deposit address for a user on an asset/network. */
  getDepositAddress(asset: string, network: string, accountId: string): Promise<DepositAddress>;

  /** Look up a withdrawal request by client-provided id. */
  getWithdrawalStatus(clientWithdrawalId: string): Promise<WithdrawalRequest>;

  /** Look up a custody transaction by provider transaction id. */
  getTransaction(providerTransactionId: string): Promise<CustodyTransaction>;
}

// ---------------------------------------------------------------------------
// Write Operations
// ---------------------------------------------------------------------------

export interface ICustodyWriteAdapter {
  /**
   * Request a withdrawal from the custody provider.
   * The provider is responsible for signing/broadcasting; this method only
   * SUBMITS the request. In Phase 9.2 the mock returns a simulated request
   * and never broadcasts anything.
   */
  requestWithdrawal(request: WithdrawalRequest): Promise<WithdrawalRequest>;

  /**
   * Advance the status of a mock/simulated transaction. Used by the mock to
   * model lifecycle transitions deterministically in tests. Real providers
   * would instead report status through lookups after blockchain events.
   */
  updateTransactionStatus(
    providerTransactionId: string,
    status: CustodyTransactionStatus,
  ): Promise<CustodyTransaction>;
}

// ---------------------------------------------------------------------------
// Combined Adapter Contract
// ---------------------------------------------------------------------------

export interface ICustodyAdapter extends ICustodyReadAdapter, ICustodyWriteAdapter {}
