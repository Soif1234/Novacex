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
  | 'REVERSED';

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
