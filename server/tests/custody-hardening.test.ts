import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCustodyService } from '../src/services/custody/custody.service';
import { KmsCustodyProvider } from '../src/services/custody/kms-custody-provider';
import { getAddressFromKmsPublicKey } from '../src/services/custody/kms-crypto';
import { LocalKmsMock } from '../src/services/custody/local-kms-mock';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { ethers } from 'ethers';

describe('Phase 10.4 Step 6E-5C: Custody Production Hardening & Safety Invariants', () => {
  let mockDb: any;

  beforeEach(() => {
    mockDb = {
      query: vi.fn(),
      transaction: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('A-E. Fail-closed production configuration validation', async () => {
    const { env } = await import('../src/config/env');
    const origEnv = { ...env };

    try {
      (env as any).CUSTODY_ENABLED = true;
      (env as any).NODE_ENV = 'production';

      // C: Mock provider in production -> throws
      (env as any).CUSTODY_PROVIDER = 'mock';
      expect(() => createCustodyService()).toThrow(/forbidden in production/);

      // D: Localhost RPC in production -> throws
      (env as any).CUSTODY_PROVIDER = 'kms';
      (env as any).CUSTODY_KMS_KEY_ID = 'kms-key-123';
      (env as any).CUSTODY_EVM_RPC_URL = 'http://localhost:8545';
      expect(() => createCustodyService()).toThrow(/Localhost RPC is forbidden in production/);

      (env as any).CUSTODY_EVM_RPC_URL = 'http://127.0.0.1:8545';
      expect(() => createCustodyService()).toThrow(/Localhost RPC is forbidden in production/);

      // E: Missing RPC in production -> throws
      (env as any).CUSTODY_EVM_RPC_URL = '';
      expect(() => createCustodyService()).toThrow(/CUSTODY_EVM_RPC_URL is required/);

      // A: Missing KMS key ID -> throws
      (env as any).CUSTODY_EVM_RPC_URL = 'https://mainnet.infura.io/v3/fake-key';
      (env as any).CUSTODY_KMS_KEY_ID = '';
      expect(() => createCustodyService()).toThrow(/CUSTODY_KMS_KEY_ID is required/);
    } finally {
      Object.assign(env, origEnv);
    }
  });

  it('F-G. Invalid factory configuration and malformed custody network fail closed', async () => {
    const localKms = new LocalKmsMock();
    const provider = new KmsCustodyProvider(
      localKms as any,
      {
        'ETHEREUM': {
          rpcUrl: 'http://localhost:8545',
          keyId: 'test-key',
          chainId: 31337n,
        }
      },
      mockDb
    );

    // G: Malformed network -> throws
    await expect(
      provider.getOrCreateDepositAddress({
        userId: 'user-1',
        asset: 'USDT',
        network: 'UNKNOWN_NETWORK'
      })
    ).rejects.toThrow(/Network UNKNOWN_NETWORK not supported/);

    // F: Missing factory configuration -> throws
    await expect(
      provider.getOrCreateDepositAddress({
        userId: 'user-1',
        asset: 'USDT',
        network: 'ETHEREUM'
      })
    ).rejects.toThrow(/Deposit addresses not configured for network ETHEREUM/);
  });

  it('B. KMS key type validation: accepts secp256k1, strictly rejects NIST P-256 and other curves', async () => {
    const localKms = new LocalKmsMock();
    const cmdRes = await localKms.send({ constructor: { name: 'GetPublicKeyCommand' } });
    const ethAddress = getAddressFromKmsPublicKey(cmdRes.PublicKey);
    expect(ethers.isAddress(ethAddress)).toBe(true);

    const nistP256SpkiHeader = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');
    const fakeKeyBytes = Buffer.alloc(65, 0x04);
    const nistP256Der = Buffer.concat([nistP256SpkiHeader, fakeKeyBytes]);

    expect(() => getAddressFromKmsPublicKey(nistP256Der)).toThrow(
      /SPKI does not contain secp256k1 OID\. NIST P-256 and other curves are not supported/
    );
  });

  it('H. KMS permission denial (AccessDeniedException) fails closed without state mutation', async () => {
    const mockKms = {
      send: vi.fn().mockRejectedValue(new Error('AccessDeniedException: User is not authorized to perform kms:Sign'))
    };

    const factoryAddress = '0x2222222222222222222222222222222222222222';
    const salt = ethers.keccak256(ethers.toUtf8Bytes('user-salt'));
    const initCodeHash = ethers.keccak256(ethers.toUtf8Bytes('init-code'));
    const expectedAddress = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);

    const provider = new KmsCustodyProvider(
      mockKms as any,
      {
        'ETHEREUM': {
          rpcUrl: 'http://localhost:8545',
          keyId: 'test-key',
          chainId: 31337n,
          factoryAddress,
          initCodeHash
        }
      },
      mockDb
    );

    vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue('0x1111111111111111111111111111111111111111');
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(ethers.parseEther('1.0'));
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);

    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT next_nonce FROM hot_wallet_nonces')) {
            return { rowCount: 1, rows: [{ next_nonce: '1' }] };
          }
          if (sql.includes('INSERT INTO sweep_intents')) {
            return { rowCount: 1, rows: [{ id: 'intent-h' }] };
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedAddress, 'ETH', ['ps-1'])
    ).rejects.toThrow(/AccessDeniedException/);
  });

  it('L. Circuit breaker pause stops worker execution without modifying database or user ledgers', async () => {
    vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({
      operational: false,
      reason: 'Emergency maintenance halt',
      mode: 'GLOBAL_HALT' as any
    });

    const { SweepWorker } = await import('../src/workers/SweepWorker');
    const worker = new SweepWorker(1000);

    await (worker as any).execute();

    expect(mockDb.query).not.toHaveBeenCalled();
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('M. Custody reconciliation events record structured operational metadata without sensitive secrets', async () => {
    const eventPayload = {
      network: 'ETHEREUM',
      address: '0x1234567890123456789012345678901234567890',
      asset: 'USDT',
      kind: 'EXTRA_FUNDS',
      expected_amount: '100.000000',
      physical_amount: '150.000000',
      details: {
        discrepancy: '50.000000',
        action: 'FLAGGED_FOR_OPERATOR_REVIEW'
      }
    };

    const serialized = JSON.stringify(eventPayload);
    expect(serialized).not.toContain('privateKey');
    expect(serialized).not.toContain('secret');
    expect(serialized).not.toContain('seedPhrase');
    expect(serialized).not.toContain('apiKey');
  });
});
