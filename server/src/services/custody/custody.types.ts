/**
 * Phase 9.2 — Custody Abstraction Layer: Provider-Neutral Domain Types
 *
 * These types describe OBJECTS ON THE CUSTODY/BLOCKCHAIN SIDE of the exchange.
 * They are deliberately distinct from the internal NovaCEX ledger models
 * (server/src/models/*, wallet_balances, ledger_entries, etc.) and must never
 * be used as wallet-balance records.
 *
 * Mapping principle:
 *   ON-CHAIN / CUSTODY OBJECT  ->  this file (e.g. CustodyBalance)
 *   INTERNAL NOVACEX LEDGER    ->  wallet_balances / ledger_entries (models/)
 *
 * No type in this file represents a user's spendable claim.
 */

/** Status of an on-chain custody transaction (deposit or withdrawal). */
export type CustodyTransactionStatus =
  | 'PENDING'
  | 'SIGNING'
  | 'BROADCAST'
  | 'CONFIRMED'
  | 'FAILED'
  | 'REJECTED'
  | 'REVERSED'
  /**
   * Phase 11K — manual Safe mode. The backend has authorized execution and is
   * awaiting a HUMAN to sign/broadcast (Safe/MetaMask). No backend signing, no
   * backend nonce allocation, no backend broadcast. This state NEVER implies a
   * blockchain transaction exists.
   */
  | 'READY_FOR_MANUAL_EXECUTION';

/** Direction of a custody transaction relative to the exchange. */
export type CustodyTransactionDirection = 'DEPOSIT' | 'WITHDRAWAL';

/**
 * Provider capabilities. Used to advertise which operations a provider
 * supports so the CAL can fail closed when an operation is unavailable.
 */
export enum CustodyProviderCapability {
  HEALTH = 'HEALTH',
  BALANCE_QUERY = 'BALANCE_QUERY',
  ASSET_NETWORK_LOOKUP = 'ASSET_NETWORK_LOOKUP',
  DEPOSIT_ADDRESS = 'DEPOSIT_ADDRESS',
  WITHDRAWAL_REQUEST = 'WITHDRAWAL_REQUEST',
  WITHDRAWAL_STATUS = 'WITHDRAWAL_STATUS',
  TRANSACTION_LOOKUP = 'TRANSACTION_LOOKUP',
  /** Phase 10.4 (unfreeze): dedicated HOUSE TREASURY transfer boundary. */
  TREASURY_TRANSFER = 'TREASURY_TRANSFER',
}

/**
 * A (asset, network) pairing supported by a custody provider.
 * Mirrors the Phase 9.1 `asset_networks` schema shape for custody purposes;
 * this is the provider-facing capability view, not a DB entity.
 */
export interface CustodyAssetNetwork {
  asset: string;
  network: string;
  isActive: boolean;
  decimals: number;
  confirmationsRequired: number;
  minDeposit: string;
  minWithdrawal: string;
  withdrawalFee: string;
  contractAddress: string | null;
  addressFormat: string;
  requiresMemo: boolean;
  networkMetadata?: Record<string, unknown>;
}

/** A custody-side account/workspace (e.g. a vault or wallet tier). */
export interface CustodyAccount {
  accountId: string;
  label?: string;
  assetNetworks?: CustodyAssetNetwork[];
}

/**
 * A balance held at the custody provider for one (asset, network).
 * This is the ON-CHAIN reserve for the exchange — NOT a user wallet_balances row.
 */
export interface CustodyBalance {
  accountId: string;
  asset: string;
  network: string;
  available: string;
  locked: string;
  total: string;
  updatedAt: Date;
}

/** Lifecycle status of a deposit address (Phase 9.3 approved model). */
export type DepositAddressStatus = 'ACTIVE' | 'ROTATED' | 'REVOKED';

/**
 * Provider-neutral get-or-create request for a deposit address.
 * User-scoped (NOT per Spot/Futures/Funding account): one ACTIVE address per
 * (user, asset, network). Phase 9.5 decides which internal account receives
 * a verified deposit.
 */
export interface GetOrCreateDepositAddressRequest {
  userId: string;
  asset: string;
  network: string;
  /** Idempotency key; provider must return the same address for the same key. */
  idempotencyKey?: string;
  /**
   * When true, the provider must generate a FRESH address even if one already
   * exists for this (userId, asset, network). Used during rotation (Phase 9.3).
   * Default false.
   */
  forceNew?: boolean;
}

/**
 * A deposit address assigned by the provider for a specific (asset, network).
 * Provider-side object — NOT a NovaCEX wallet_balances record.
 */
export interface DepositAddress {
  address: string;
  asset: string;
  network: string;
  userId: string;
  requiresMemo: boolean;
  memo?: string;
  providerId: string;
  providerAddressId?: string;
  status: DepositAddressStatus;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

/** Provider-neutral withdrawal request. */
export interface WithdrawalRequest {
  clientWithdrawalId: string;
  providerWithdrawalId?: string;
  accountId: string;
  asset: string;
  network: string;
  amount: string;
  destinationAddress: string;
  destinationMemo?: string;
  status: CustodyTransactionStatus;
  createdAt: Date;
  updatedAt: Date;
  providerReference?: string;
}

/**
 * Phase 10.4 (unfreeze) — the HOUSE TREASURY principal.
 *
 * CUSTOMER ≠ HOUSE ≠ TREASURY at the custody boundary:
 *   - `requestWithdrawal` (customer op) REJECTS this principal.
 *   - `submitTreasuryTransfer` (treasury op) is the ONLY operation allowed to
 *     act for it, and it never touches customer tables or customer accounting.
 * Defined here (types) so both the CAL and providers can reference it without
 * import cycles.
 */
export const HOUSE_TREASURY_ACCOUNT_ID = 'HOUSE_TREASURY';

/**
 * Phase 10.4 (unfreeze) — dedicated HOUSE TREASURY custody operation.
 *
 * This type exists to keep the treasury custody boundary STRUCTURALLY
 * distinct from the customer withdrawal operation:
 *   - `requestWithdrawal` is the CUSTOMER path (real account UUID principal,
 *     withdrawals-table lifecycle, customer ledger semantics).
 *   - `submitTreasuryTransfer` is the TREASURY path (treasuryIntentId
 *     correlation, no customer account, no customer ledger effects).
 * The two operations reject each other's principals (enforced in CustodyService).
 */
export interface TreasuryTransferRequest {
  /** Immutable correlation ID — the treasury_transactions client_withdrawal_id. */
  treasuryIntentId: string;
  asset: string;
  network: string;
  /** Exact base-unit string. */
  amount: string;
  /** MUST be the trusted Safe address resolved by the treasury layer. */
  destinationAddress: string;
}

/** Provider-neutral custody transaction (deposit or withdrawal on-chain). */
export interface CustodyTransaction {
  providerTransactionId: string;
  direction: CustodyTransactionDirection;
  asset: string;
  network: string;
  amount: string;
  status: CustodyTransactionStatus;
  confirmations?: number;
  address?: string;
  createdAt: Date;
  updatedAt: Date;
  providerReference?: string;
}

/** Provider health/status snapshot. */
export interface CustodyProviderHealth {
  providerId: string;
  healthy: boolean;
  latencyMs: number;
  detail?: string;
  checkedAt: Date;
}

export interface ReplacementGasPolicy {
  minimumMultiplier: number;
  maxFeePerGasCeiling?: bigint;
  maxPriorityFeePerGasCeiling?: bigint;
}

export interface SweepStatusResult {
  status: 'BROADCAST' | 'CONFIRMED' | 'FAILED';
  blockNumber?: number;
  blockHash?: string;
  confirmations?: number;
}
