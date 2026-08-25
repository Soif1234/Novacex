/**
 * Asset/Network Model (Phase 9.1 — Asset + Network Architecture)
 *
 * Explicitly models the (asset, network) pairing: a token symbol alone does not
 * identify a blockchain asset.  For example, USDT on Ethereum ERC-20 and USDT on
 * Tron TRC-20 are distinct (asset, network) rows with different contract addresses,
 * confirmation requirements, and address formats.
 *
 * This model is the reference for all future custody, deposit, and withdrawal
 * flows (Phases 9.3+).  It is NOT the internal ledger display precision
 * (`assets.decimals` in migration 002, which is 8 for all assets).
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Canonical blockchain network key.  Extended by future phases as new chains
 * are added (e.g. 'TRON', 'SOLANA', 'XRP').
 */
export type BlockchainNetwork = 'ETHEREUM' | 'BITCOIN';

/**
 * Address format on the blockchain.  Determines how addresses are validated
 * and displayed.
 */
export type AddressFormat = 'EVM_HEX' | 'BITCOIN_BECH32';

/**
 * Token standard (conceptually distinct from the underlying chain).
 */
export type TokenStandard = 'NATIVE' | 'ERC20' | 'TRC20' | 'SPL';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SUPPORTED_NETWORKS: readonly BlockchainNetwork[] = ['ETHEREUM', 'BITCOIN'];
export const SUPPORTED_ADDRESS_FORMATS: readonly AddressFormat[] = ['EVM_HEX', 'BITCOIN_BECH32'];
export const SUPPORTED_TOKEN_STANDARDS: readonly TokenStandard[] = ['NATIVE', 'ERC20', 'TRC20', 'SPL'];

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

/**
 * Flexible metadata stored alongside each (asset, network) row.
 * Fields are provider-agnostic by default; the optional `[key: string]` indexer
 * allows provider-specific extensions (e.g. Fireblocks asset id, BitGo coin id).
 */
export interface AssetNetworkMetadata {
  chainId?: number;
  tokenStandard?: TokenStandard;
  explorerUrl?: string;
  [key: string]: unknown;
}

/**
 * Full entity mirroring the `asset_networks` database table (migration 016).
 */
export interface AssetNetworkEntity {
  asset: string;
  network: BlockchainNetwork;
  isActive: boolean;
  decimals: number;
  confirmationsRequired: number;
  minDeposit: string;
  minWithdrawal: string;
  withdrawalFee: string;
  contractAddress: string | null;
  addressFormat: AddressFormat;
  requiresMemo: boolean;
  networkMetadata: AssetNetworkMetadata;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Concise primary key representation for lookups.
 */
export interface AssetNetworkKey {
  asset: string;
  network: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NUMERIC_AMOUNT_RE = /^\d+(\.\d+)?$/;

/** @returns the canonical string key for a pair, e.g. "USDT:ETHEREUM" */
export function toAssetNetworkKey(asset: string, network: string): string {
  return `${asset.trim().toUpperCase()}:${network.trim().toUpperCase()}`;
}

export function isSupportedNetwork(value: string): value is BlockchainNetwork {
  return (SUPPORTED_NETWORKS as readonly string[]).includes(value);
}

export function isSupportedAddressFormat(value: string): value is AddressFormat {
  return (SUPPORTED_ADDRESS_FORMATS as readonly string[]).includes(value);
}

export function isSupportedTokenStandard(value: string): value is TokenStandard {
  return (SUPPORTED_TOKEN_STANDARDS as readonly string[]).includes(value);
}

/**
 * Validate a contract address against the declared address format.
 * `null` is always valid (native asset case).
 */
export function isValidContractAddress(
  address: string | null,
  format: AddressFormat,
): boolean {
  if (address === null || address === undefined) return true;
  if (format === 'EVM_HEX') return /^0x[a-fA-F0-9]{40}$/.test(address);
  if (format === 'BITCOIN_BECH32') return /^bc1[a-zA-HJ-NP-Z0-9]{25,59}$/.test(address);
  return true; // unknown format — accept to avoid false rejections
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function validateAssetNetwork(
  entity: AssetNetworkEntity,
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // asset
  if (!entity.asset || typeof entity.asset !== 'string' || entity.asset.trim().length === 0) {
    errors.push('asset must be a non-empty string');
  }

  // network
  if (!isSupportedNetwork(entity.network)) {
    errors.push(`network must be one of: ${SUPPORTED_NETWORKS.join(', ')}`);
  }

  // isActive
  if (typeof entity.isActive !== 'boolean') {
    errors.push('isActive must be a boolean');
  }

  // decimals
  if (!Number.isInteger(entity.decimals) || entity.decimals < 0) {
    errors.push('decimals must be a non-negative integer');
  }

  // confirmationsRequired
  if (!Number.isInteger(entity.confirmationsRequired) || entity.confirmationsRequired < 1) {
    errors.push('confirmationsRequired must be a positive integer');
  }

  // Amount fields: must be non-empty, non-negative numeric strings
  for (const [field, value] of [
    ['minDeposit', entity.minDeposit],
    ['minWithdrawal', entity.minWithdrawal],
    ['withdrawalFee', entity.withdrawalFee],
  ] as const) {
    if (typeof value !== 'string' || !NUMERIC_AMOUNT_RE.test(value)) {
      errors.push(`${field} must be a non-negative numeric string`);
    }
  }

  // addressFormat
  if (!isSupportedAddressFormat(entity.addressFormat)) {
    errors.push(`addressFormat must be one of: ${SUPPORTED_ADDRESS_FORMATS.join(', ')}`);
  }

  // contractAddress
  if (!isValidContractAddress(entity.contractAddress, entity.addressFormat)) {
    errors.push('contractAddress is not valid for the given addressFormat');
  }

  // requiresMemo
  if (typeof entity.requiresMemo !== 'boolean') {
    errors.push('requiresMemo must be a boolean');
  }

  // networkMetadata
  if (entity.networkMetadata === null || typeof entity.networkMetadata !== 'object' || Array.isArray(entity.networkMetadata)) {
    errors.push('networkMetadata must be a plain object');
  }

  return { valid: errors.length === 0, errors };
}