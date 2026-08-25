import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  AssetNetworkEntity,
  AssetNetworkKey,
  SUPPORTED_NETWORKS,
  SUPPORTED_ADDRESS_FORMATS,
  SUPPORTED_TOKEN_STANDARDS,
  toAssetNetworkKey,
  isSupportedNetwork,
  isSupportedAddressFormat,
  isSupportedTokenStandard,
  isValidContractAddress,
  validateAssetNetwork,
} from '../src/models/asset-network.model';

// Resolve the migration file from the server working directory (or repo root).
function resolveMigrationPath(): string {
  const candidates = [
    path.resolve(process.cwd(), 'migrations', '016_create_asset_networks.sql'),
    path.resolve(process.cwd(), 'server', 'migrations', '016_create_asset_networks.sql'),
  ];
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) {
    throw new Error('Migration 016_create_asset_networks.sql not found');
  }
  return found;
}

function makeValidEntity(overrides: Partial<AssetNetworkEntity> = {}): AssetNetworkEntity {
  return {
    asset: 'USDT',
    network: 'ETHEREUM',
    isActive: true,
    decimals: 6,
    confirmationsRequired: 12,
    minDeposit: '10',
    minWithdrawal: '10',
    withdrawalFee: '1',
    contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
    addressFormat: 'EVM_HEX',
    requiresMemo: false,
    networkMetadata: { chainId: 1, tokenStandard: 'ERC20', explorerUrl: 'https://etherscan.io' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('Asset/Network Model (Phase 9.1)', () => {
  describe('1. Migration schema (016_create_asset_networks.sql)', () => {
    const sql = fs.readFileSync(resolveMigrationPath(), 'utf-8');

    it('1a. Creates the asset_networks table additively (IF NOT EXISTS, no ALTER)', () => {
      expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS asset_networks/i);
      // Must not alter existing tables
      expect(sql).not.toMatch(/ALTER\s+TABLE/i);
      // Must not touch wallet/ledger/trading schema
      expect(sql).not.toMatch(/wallet_balances/i);
      expect(sql).not.toMatch(/ledger_entries/i);
      expect(sql).not.toMatch(/ledger_transactions/i);
      expect(sql).not.toMatch(/orders/i);
    });

    it('1b. Declares the composite primary key (asset, network)', () => {
      expect(sql).toMatch(/PRIMARY KEY\s*\(\s*asset\s*,\s*network\s*\)/i);
    });

    it('1c. Declares all required columns', () => {
      const requiredColumns = [
        'asset',
        'network',
        'is_active',
        'decimals',
        'confirmations_required',
        'min_deposit',
        'min_withdrawal',
        'withdrawal_fee',
        'contract_address',
        'address_format',
        'requires_memo',
        'network_metadata',
      ];
      for (const col of requiredColumns) {
        expect(sql).toMatch(new RegExp(`\\b${col}\\b`, 'i'));
      }
    });

    it('1d. Seeds exactly the approved initial pairs: USDT-ERC20, USDC-ERC20, BTC, ETH', () => {
      const expectedPairs = [
        ["'USDT'", "'ETHEREUM'"],
        ["'USDC'", "'ETHEREUM'"],
        ["'BTC'", "'BITCOIN'"],
        ["'ETH'", "'ETHEREUM'"],
      ];
      for (const [asset, network] of expectedPairs) {
        expect(sql).toMatch(new RegExp(`${asset}\\s*,\\s*${network}`, 'i'));
      }
      // ERC-20 tokens carry contract addresses; native assets do not.
      expect(sql).toMatch(/0xdAC17F958D2ee523a2206206994597C13D831ec7/i); // USDT
      expect(sql).toMatch(/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48/i); // USDC
    });

    it('1e. Uses numeric precision consistent with the ledger (NUMERIC(36,18))', () => {
      const amountMatches = sql.match(/NUMERIC\(\s*36\s*,\s*18\s*\)/gi) || [];
      // min_deposit, min_withdrawal, withdrawal_fee => at least 3
      expect(amountMatches.length).toBeGreaterThanOrEqual(3);
    });

    it('1f. Migration version prefix is 016 and file is parseable SQL', () => {
      const filename = path.basename(resolveMigrationPath());
      expect(filename.startsWith('016_')).toBe(true);
      expect(sql.length).toBeGreaterThan(100);
    });
  });

  describe('2. Model constants', () => {
    it('2a. Supported networks are exactly the approved Phase 9.1 set', () => {
      expect([...SUPPORTED_NETWORKS].sort()).toEqual(['BITCOIN', 'ETHEREUM']);
    });

    it('2b. Address formats and token standards are defined', () => {
      expect(SUPPORTED_ADDRESS_FORMATS).toContain('EVM_HEX');
      expect(SUPPORTED_ADDRESS_FORMATS).toContain('BITCOIN_BECH32');
      expect(SUPPORTED_TOKEN_STANDARDS).toEqual(['NATIVE', 'ERC20', 'TRC20', 'SPL']);
    });

    it('2c. toAssetNetworkKey builds canonical composite keys', () => {
      expect(toAssetNetworkKey('usdt', 'ethereum')).toBe('USDT:ETHEREUM');
      const key: AssetNetworkKey = { asset: 'BTC', network: 'BITCOIN' };
      expect(toAssetNetworkKey(key.asset, key.network)).toBe('BTC:BITCOIN');
    });
  });

  describe('3. Predicate validation helpers', () => {
    it('3a. isSupportedNetwork accepts approved networks only', () => {
      expect(isSupportedNetwork('ETHEREUM')).toBe(true);
      expect(isSupportedNetwork('BITCOIN')).toBe(true);
      expect(isSupportedNetwork('TRON')).toBe(false);
      expect(isSupportedNetwork('ethereum')).toBe(false); // case-sensitive
    });

    it('3b. isSupportedAddressFormat accepts defined formats only', () => {
      expect(isSupportedAddressFormat('EVM_HEX')).toBe(true);
      expect(isSupportedAddressFormat('BITCOIN_BECH32')).toBe(true);
      expect(isSupportedAddressFormat('BASE58')).toBe(false);
    });

    it('3c. isSupportedTokenStandard accepts defined standards only', () => {
      expect(isSupportedTokenStandard('NATIVE')).toBe(true);
      expect(isSupportedTokenStandard('ERC20')).toBe(true);
      expect(isSupportedTokenStandard('BEP20')).toBe(false);
    });

    it('3d. isValidContractAddress validates per format', () => {
      expect(isValidContractAddress(null, 'EVM_HEX')).toBe(true); // native
      expect(isValidContractAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'EVM_HEX')).toBe(true);
      expect(isValidContractAddress('0xabc', 'EVM_HEX')).toBe(false);
      expect(isValidContractAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BITCOIN_BECH32')).toBe(true);
      expect(isValidContractAddress('0xdAC17F958D2ee523a2206206994597C13D831ec7', 'BITCOIN_BECH32')).toBe(false);
    });
  });

  describe('4. validateAssetNetwork', () => {
    it('4a. Accepts a fully valid USDT/ETHEREUM entity', () => {
      const result = validateAssetNetwork(makeValidEntity());
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('4b. Rejects unsupported network', () => {
      const result = validateAssetNetwork(makeValidEntity({ network: 'TRON' as any }));
      expect(result.valid).toBe(false);
      expect(result.errors.join()).toMatch(/network must be one of/i);
    });

    it('4c. Rejects invalid decimals', () => {
      expect(validateAssetNetwork(makeValidEntity({ decimals: -1 })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ decimals: 1.5 })).valid).toBe(false);
    });

    it('4d. Rejects invalid confirmationsRequired', () => {
      expect(validateAssetNetwork(makeValidEntity({ confirmationsRequired: 0 })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ confirmationsRequired: -3 })).valid).toBe(false);
    });

    it('4e. Rejects malformed amount fields', () => {
      expect(validateAssetNetwork(makeValidEntity({ minDeposit: '-5' })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ minWithdrawal: 'abc' })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ withdrawalFee: '' })).valid).toBe(false);
    });

    it('4f. Rejects invalid address format and mismatched contract address', () => {
      expect(validateAssetNetwork(makeValidEntity({ addressFormat: 'BASE58' as any })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ contractAddress: 'not-an-address' })).valid).toBe(false);
    });

    it('4g. Rejects non-boolean isActive and requiresMemo', () => {
      expect(validateAssetNetwork(makeValidEntity({ isActive: 'yes' as any })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ requiresMemo: 1 as any })).valid).toBe(false);
    });

    it('4h. Rejects null/non-object networkMetadata', () => {
      expect(validateAssetNetwork(makeValidEntity({ networkMetadata: null as any })).valid).toBe(false);
      expect(validateAssetNetwork(makeValidEntity({ networkMetadata: [] as any })).valid).toBe(false);
    });
  });

  describe('5. Approved seed entities validate cleanly', () => {
    it('5a. The four approved pairs are all valid model entities', () => {
      const approved: AssetNetworkEntity[] = [
        {
          asset: 'USDT', network: 'ETHEREUM', isActive: true, decimals: 6,
          confirmationsRequired: 12, minDeposit: '10', minWithdrawal: '10', withdrawalFee: '1',
          contractAddress: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
          addressFormat: 'EVM_HEX', requiresMemo: false,
          networkMetadata: { chainId: 1, tokenStandard: 'ERC20', explorerUrl: 'https://etherscan.io' },
          createdAt: new Date(), updatedAt: new Date(),
        },
        {
          asset: 'USDC', network: 'ETHEREUM', isActive: true, decimals: 6,
          confirmationsRequired: 12, minDeposit: '10', minWithdrawal: '10', withdrawalFee: '1',
          contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
          addressFormat: 'EVM_HEX', requiresMemo: false,
          networkMetadata: { chainId: 1, tokenStandard: 'ERC20', explorerUrl: 'https://etherscan.io' },
          createdAt: new Date(), updatedAt: new Date(),
        },
        {
          asset: 'BTC', network: 'BITCOIN', isActive: true, decimals: 8,
          confirmationsRequired: 2, minDeposit: '0.0001', minWithdrawal: '0.0001', withdrawalFee: '0.00005',
          contractAddress: null, addressFormat: 'BITCOIN_BECH32', requiresMemo: false,
          networkMetadata: { tokenStandard: 'NATIVE', explorerUrl: 'https://mempool.space' },
          createdAt: new Date(), updatedAt: new Date(),
        },
        {
          asset: 'ETH', network: 'ETHEREUM', isActive: true, decimals: 18,
          confirmationsRequired: 12, minDeposit: '0.01', minWithdrawal: '0.01', withdrawalFee: '0.005',
          contractAddress: null, addressFormat: 'EVM_HEX', requiresMemo: false,
          networkMetadata: { chainId: 1, tokenStandard: 'NATIVE', explorerUrl: 'https://etherscan.io' },
          createdAt: new Date(), updatedAt: new Date(),
        },
      ];
      for (const entity of approved) {
        const result = validateAssetNetwork(entity);
        expect(result.valid).toBe(true);
        expect(result.errors).toEqual([]);
      }
    });
  });
});
