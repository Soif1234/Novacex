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

/** A deposit address assigned by the provider for a specific (asset, network). */
export interface DepositAddress {
  address: string;
  asset: string;
  network: string;
  accountId: string;
  requiresMemo: boolean;
  memo?: string;
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
