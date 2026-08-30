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
  GetOrCreateDepositAddressRequest,
  TreasuryTransferRequest,
  WithdrawalRequest,
  ReplacementGasPolicy,
  SweepStatusResult,
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

  /**
   * Get-or-create a deposit address for a user on an asset/network.
   * USER-scoped (not per Spot/Futures/Funding account). Idempotent: the same
   * (userId, asset, network) must always resolve to the same address.
   * Phase 9.3: the mock generates a deterministic in-memory address; no real
   * blockchain interaction occurs.
   */
  getOrCreateDepositAddress(request: GetOrCreateDepositAddressRequest): Promise<DepositAddress>;

  /** Look up a withdrawal request by client-provided id. */
  getWithdrawalStatus(clientWithdrawalId: string): Promise<WithdrawalRequest>;

  /**
   * Phase 10.4 (unfreeze): status lookup for a treasury transfer by its
   * immutable treasuryIntentId. providerReference MUST be the physical
   * blockchain tx hash once one exists.
   */
  getTreasuryTransferStatus?(treasuryIntentId: string): Promise<WithdrawalRequest>;

  /** Look up a custody transaction by provider transaction id. */
  getTransaction(providerTransactionId: string): Promise<CustodyTransaction>;

  /** Check the status of a broadcasted sweep transaction. */
  checkSweepStatus?(txHash: string, network: string): Promise<SweepStatusResult>;

  /**
   * P2 (6E-4C-2): presence probe for a broadcast sweep transaction —
   * still pending in mempool vs mined vs dropped. `nonceConsumed` reports
   * whether the chain nonce has moved past the artifact's nonce (evidence of
   * an external replacement).
   */
  getSweepTxPresence?(
    txHash: string,
    network: string,
    expectedNonce?: number
  ): Promise<{ present: boolean; mined: boolean; nonceConsumed: boolean | null }>;

  /**
   * P2 (6E-4C-2): physical-vs-database reconciliation for one forwarder
   * group. Purely operational — records custody_reconciliation_events, never
   * touches user balances.
   */
  reconcileDepositAddress?(
    network: string,
    address: string,
    asset: string
  ): Promise<{ expectedRemaining: string; physical: string; status: 'BALANCED' | 'EXTRA_FUNDS' | 'SHORTFALL' }>;
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
   * Request a replacement/speed-up transaction for a pending withdrawal.
   */
  replaceWithdrawal?(clientWithdrawalId: string, gasPolicy: ReplacementGasPolicy): Promise<WithdrawalRequest>;

  /**
   * Request a cancellation transaction (0 value to self) for a pending withdrawal.
   */
  cancelWithdrawal?(clientWithdrawalId: string, gasPolicy: ReplacementGasPolicy): Promise<WithdrawalRequest>;

  /**
   * Instruct the custody provider to sweep the balance of a deposit address to the hot wallet.
   * Groups multiple pending sweep requests for the same address.
   */
  sweepDepositAddress?(
    network: string,
    depositAddress: string,
    asset: string,
    pendingSweepIds: string[]
  ): Promise<string>;
  /**
   * Check the status of a broadcasted sweep transaction.
   */
  checkSweepStatus?(txHash: string, network: string): Promise<SweepStatusResult>;

  /**
   * P2 (6E-4C-2): presence probe for a broadcast sweep transaction.
   */
  getSweepTxPresence?(
    txHash: string,
    network: string,
    expectedNonce?: number
  ): Promise<{ present: boolean; mined: boolean; nonceConsumed: boolean | null }>;

  /**
   * P2 (6E-4C-2): physical-vs-database custody reconciliation.
   */
  reconcileDepositAddress?(
    network: string,
    address: string,
    asset: string
  ): Promise<{ expectedRemaining: string; physical: string; status: 'BALANCED' | 'EXTRA_FUNDS' | 'SHORTFALL' }>;


  /**
   * Advance the status of a mock/simulated transaction. Used by the mock to
   * model lifecycle transitions deterministically in tests. Real providers
   * would instead report status through lookups after blockchain events.
   */
  updateTransactionStatus(
    providerTransactionId: string,
    status: CustodyTransactionStatus,
  ): Promise<CustodyTransaction>;

  /**
   * Phase 10.4 (unfreeze): dedicated HOUSE TREASURY transfer operation.
   *
   * Structurally SEPARATE from requestWithdrawal (customer path):
   *   - correlation is treasuryIntentId (never a customer withdrawal id),
   *   - the principal is the house treasury, never a customer account,
   *   - artifacts are persisted in the treasury custody artifact store
   *     (never in the customer withdrawal_transactions table),
   *   - no customer ledger/wallet semantics are reachable from here.
   * Providers advertise it via CustodyProviderCapability.TREASURY_TRANSFER.
   * Optional: providers without treasury support simply omit it and the CAL
   * fails closed with CustodyCapabilityUnavailableError.
   */
  submitTreasuryTransfer?(request: TreasuryTransferRequest): Promise<WithdrawalRequest>;
}

// ---------------------------------------------------------------------------
// Combined Adapter Contract
// ---------------------------------------------------------------------------

export interface ICustodyAdapter extends ICustodyReadAdapter, ICustodyWriteAdapter {}
