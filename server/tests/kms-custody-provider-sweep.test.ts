import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KmsCustodyProvider } from '../src/services/custody/kms-custody-provider';
import { ethers, Transaction } from 'ethers';

describe('KmsCustodyProvider Sweep Security & Recovery Invariants', () => {
  let mockKms: any;
  let mockDb: any;
  let provider: KmsCustodyProvider;

  const hotWalletAddress = '0x1111111111111111111111111111111111111111';
  const factoryAddress = '0x2222222222222222222222222222222222222222';
  const salt = ethers.keccak256(ethers.toUtf8Bytes('user-eth-salt'));
  const initCodeHash = ethers.keccak256(ethers.toUtf8Bytes('mock-init-code'));

  // Calculate actual create2 address for exact matching
  const expectedCreate2 = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);

  beforeEach(() => {
    mockKms = {
      send: vi.fn()
    };

    mockDb = {
      query: vi.fn(),
      transaction: vi.fn()
    };

    provider = new KmsCustodyProvider(
      mockKms as any,
      {
        'ETHEREUM': {
          rpcUrl: 'http://localhost:8545',
          keyId: 'mock-key-id',
          chainId: 31337n,
          factoryAddress,
          initCodeHash
        }
      },
      mockDb
    );

    vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue(hotWalletAddress);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('B. Dust check throws DUST before nonce allocation, keeping hot_wallet_nonces untouched', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{
            address_metadata: {
              factoryAddress,
              salt,
              initCodeHash
            }
          }]
        };
      }
      if (sql.includes('hot_wallet_nonces')) {
        throw new Error('UNEXPECTED: hot_wallet_nonces should not be touched on DUST');
      }
      return { rowCount: 0, rows: [] };
    });

    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(100n);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow('DUST');

    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('C-F. Recovery validation fails closed if nonce, chainId, destination, or calldata mutated', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(ethers.parseEther('1.0'));
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);

    const deterministicKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
    const wallet = new ethers.Wallet(deterministicKey);
    vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue(wallet.address);

    // Construct a signed transaction with wrong chainId
    const factoryInterface = new ethers.Interface([
      "function deployAndSweepETH(bytes32 salt) external returns (address proxy)"
    ]);
    const txData = factoryInterface.encodeFunctionData("deployAndSweepETH", [salt]);

    const tx = Transaction.from({
      to: factoryAddress,
      value: 0n,
      data: txData,
      nonce: 5,
      chainId: 1n, // Wrong chainId (configured is 31337n)
      type: 2
    });
    tx.signature = wallet.signingKey.sign(tx.unsignedHash);

    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 1, rows: [{ sweep_txid: tx.hash }] };
          }
          if (sql.includes('SELECT tx_hash, raw_signed_tx')) {
            return {
              rowCount: 1,
              rows: [{
                tx_hash: tx.hash,
                raw_signed_tx: tx.serialized,
                network_nonce: 5
              }]
            };
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow(/CRITICAL: Persisted raw_signed_tx (chainId|sender|destination|nonce|calldata)/);
  });

  it('G. Recovery receipt.status = 0 marks FAILED and reverts pending_sweeps to PENDING', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    const factoryInterface = new ethers.Interface([
      "function deployAndSweepETH(bytes32 salt) external returns (address proxy)"
    ]);
    const txData = factoryInterface.encodeFunctionData("deployAndSweepETH", [salt]);

    // Create valid signed transaction with deterministic wallet
    const deterministicKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
    const wallet = new ethers.Wallet(deterministicKey);
    vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue(wallet.address);

    const tx = Transaction.from({
      to: factoryAddress,
      value: 0n,
      data: txData,
      nonce: 5,
      chainId: 31337n,
      type: 2
    });
    tx.signature = wallet.signingKey.sign(tx.unsignedHash);

    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(ethers.parseEther('1.0'));
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransaction').mockResolvedValue({ hash: tx.hash } as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValue({
      status: 0, // REVERTED
      blockNumber: 100,
      blockHash: '0xrevertblock'
    } as any);

    let failedQueryExecuted = false;
    let pendingRevertQueryExecuted = false;

    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 1, rows: [{ sweep_txid: tx.hash }] };
          }
          if (sql.includes('SELECT tx_hash, raw_signed_tx')) {
            return {
              rowCount: 1,
              rows: [{
                tx_hash: tx.hash,
                raw_signed_tx: tx.serialized,
                network_nonce: 5
              }]
            };
          }
          if (sql.includes('UPDATE sweep_transactions SET status = \'FAILED\'')) {
            failedQueryExecuted = true;
          }
          if (sql.includes('UPDATE pending_sweeps SET status = \'PENDING\', sweep_txid = NULL')) {
            pendingRevertQueryExecuted = true;
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow(/reverted on-chain/);

    expect(failedQueryExecuted).toBe(true);
    expect(pendingRevertQueryExecuted).toBe(true);
  });

  it('H-I. Recovery receipt.status = 1 checks confirmation depth', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('SELECT confirmations_required FROM asset_networks')) {
        return { rowCount: 1, rows: [{ confirmations_required: 12 }] };
      }
      return { rowCount: 0, rows: [] };
    });

    const factoryInterface = new ethers.Interface([
      "function deployAndSweepETH(bytes32 salt) external returns (address proxy)"
    ]);
    const txData = factoryInterface.encodeFunctionData("deployAndSweepETH", [salt]);

    const deterministicKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
    const wallet = new ethers.Wallet(deterministicKey);
    vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue(wallet.address);

    const tx = Transaction.from({
      to: factoryAddress,
      value: 0n,
      data: txData,
      nonce: 5,
      chainId: 31337n,
      type: 2
    });
    tx.signature = wallet.signingKey.sign(tx.unsignedHash);

    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(ethers.parseEther('1.0'));
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransaction').mockResolvedValue({ hash: tx.hash } as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValue({
      status: 1,
      blockNumber: 100,
      blockHash: '0xconfirmedblock'
    } as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBlockNumber').mockResolvedValue(120); // 21 confirmations > 12

    let confirmedQueryExecuted = false;
    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 1, rows: [{ sweep_txid: tx.hash }] };
          }
          if (sql.includes('SELECT tx_hash, raw_signed_tx')) {
            return {
              rowCount: 1,
              rows: [{
                tx_hash: tx.hash,
                raw_signed_tx: tx.serialized,
                network_nonce: 5
              }]
            };
          }
          if (sql.includes('UPDATE sweep_transactions SET status = \'CONFIRMED\'')) {
            confirmedQueryExecuted = true;
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    const result = await provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1']);
    expect(result).toBe(tx.hash);
    expect(confirmedQueryExecuted).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Phase 10.4 Step 6E-4C-2 â€” P0: durable sweep intents
  // -------------------------------------------------------------------------

  function baseSweepDbMock(): void {
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
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 0, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(ethers.parseEther('1.0'));
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);
  }

  function forbidNonces(): void {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('FROM sweep_intents')) {
        return { rowCount: 1, rows: [{ id: 'intent-1', network_nonce: 5 }] };
      }
      if (sql.includes('hot_wallet_nonces')) {
        throw new Error('UNEXPECTED: hot_wallet_nonces must never be touched during intent reuse');
      }
      return { rowCount: 0, rows: [] };
    });
  }

  it('1. Crash after reservation: open intent reuses the SAME nonce, hot_wallet_nonces untouched', async () => {
    baseSweepDbMock();
    forbidNonces();

    // Chain state: nonce 5 unused (latest == 5, nothing pending beyond it)
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionCount').mockImplementation(
      async (_addr: string, blockTag?: any) => (blockTag === 'pending' ? 5 : 5)
    );

    let intentLinkQuery = false;
    let intentIdLinked: string | null = null;
    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('sweep_intent_id = $1')) {
            intentLinkQuery = true;
            intentIdLinked = params[0];
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    mockKms.send.mockRejectedValue(new Error('KMS_TEST_STOP'));

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow('KMS_TEST_STOP');

    // The flow reached signing (KMS) using the intent's reserved nonce 5,
    // linked the rows to the EXISTING intent, and never re-allocated.
    expect(intentLinkQuery).toBe(true);
    expect(intentIdLinked).toBe('intent-1');
  });

  it('2. Reserved nonce consumed externally: intent and rows go to RECONCILIATION, no new nonce', async () => {
    baseSweepDbMock();
    forbidNonces();

    // Chain state: latest nonce already at 6 â€” reserved nonce 5 was consumed.
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionCount').mockImplementation(
      async (_addr: string, blockTag?: any) => (blockTag === 'pending' ? 6 : 6)
    );

    let intentReconciled = false;
    let rowsReconciled = false;
    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes("UPDATE sweep_intents SET status = 'RECONCILIATION'")) intentReconciled = true;
          if (sql.includes("UPDATE pending_sweeps SET status = 'RECONCILIATION'")) rowsReconciled = true;
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow(/requires manual reconciliation/);

    expect(intentReconciled).toBe(true);
    expect(rowsReconciled).toBe(true);
  });

  it('3. External transaction pending at or below the reserved nonce: RECONCILIATION, no signing', async () => {
    baseSweepDbMock();
    forbidNonces();

    // latest == 5 (reserved nonce not yet mined) but pending == 6 â€” an unknown
    // transaction occupies a nonce at or below 5.
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionCount').mockImplementation(
      async (_addr: string, blockTag?: any) => (blockTag === 'pending' ? 6 : 5)
    );

    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] })
      };
      return await cb(client);
    });

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow(/external transaction\(s\) pending/);
  });

  it('4. Fresh sweep: nonce reservation, sweep_intents INSERT, and row linkage commit in ONE transaction', async () => {
    baseSweepDbMock();

    // No open intent exists.
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('FROM sweep_intents')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const txSqlLog: string[] = [];
    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          txSqlLog.push(sql);
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes('SELECT next_nonce FROM hot_wallet_nonces')) {
            return { rowCount: 1, rows: [{ next_nonce: 7 }] };
          }
          if (sql.includes('INSERT INTO sweep_intents')) {
            return { rowCount: 1, rows: [{ id: 'intent-new' }] };
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    mockKms.send.mockRejectedValue(new Error('KMS_TEST_STOP'));

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1'])
    ).rejects.toThrow('KMS_TEST_STOP');

    // Atomicity invariant: nonce increment + intent insert + row linkage
    // must have executed against the SAME transaction client.
    const nonceUpdateIdx = txSqlLog.findIndex(s => s.includes('UPDATE hot_wallet_nonces SET next_nonce = next_nonce + 1'));
    const intentInsertIdx = txSqlLog.findIndex(s => s.includes('INSERT INTO sweep_intents'));
    const linkageIdx = txSqlLog.findIndex(s => s.includes('sweep_intent_id = $1'));
    expect(nonceUpdateIdx).toBeGreaterThanOrEqual(0);
    expect(intentInsertIdx).toBeGreaterThan(nonceUpdateIdx);
    expect(linkageIdx).toBeGreaterThan(intentInsertIdx);
  });

  // -------------------------------------------------------------------------
  // Phase 10.4 Step 6E-4C-2 â€” P2: ERC20 dust gate before nonce
  // -------------------------------------------------------------------------

  const tokenContract = '0x3333333333333333333333333333333333333333';

  function erc20SweepDbMock(balance: bigint): void {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('FROM asset_networks WHERE asset')) {
        return { rowCount: 1, rows: [{ contract_address: tokenContract }] };
      }
      if (sql.includes('hot_wallet_nonces')) {
        throw new Error('UNEXPECTED: hot_wallet_nonces touched on ERC20 dust path');
      }
      return { rowCount: 0, rows: [] };
    });
    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = { query: vi.fn().mockResolvedValue({ rowCount: 0, rows: [] }) };
      return await cb(client);
    });
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'call').mockResolvedValue(
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [balance])
    );
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);
  }

  it('K. ERC20 below configured base-unit minimum: SweepDustError BEFORE nonce/signing', async () => {
    const { env } = await import('../src/config/env');
    const original = env.CUSTODY_SWEEP_MIN_TOKEN_UNITS;
    (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = 'USDT=1000000';
    try {
      erc20SweepDbMock(100n); // 100 base units < 1,000,000 minimum
      await expect(
        provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'USDT', ['ps-1'])
      ).rejects.toThrow(/DUST/);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    } finally {
      (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = original;
    }
  });

  it('L. ERC20 above minimum but gas estimation fails: transient failure, NO nonce reserved', async () => {
    const { env } = await import('../src/config/env');
    const original = env.CUSTODY_SWEEP_MIN_TOKEN_UNITS;
    (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = 'USDT=1000000';
    try {
      erc20SweepDbMock(2_000_000n); // above minimum
      vi.spyOn(ethers.JsonRpcProvider.prototype, 'estimateGas').mockRejectedValue(new Error('execution reverted'));
      await expect(
        provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'USDT', ['ps-1'])
      ).rejects.toThrow(/SWEEP_GAS_ESTIMATE_UNAVAILABLE/);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    } finally {
      (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = original;
    }
  });

  // -------------------------------------------------------------------------
  // Phase 10.4 Step 6E-4C-2 â€” P2: zero balance investigation
  // -------------------------------------------------------------------------

  it('M. Zero balance with matching confirmed sweep history: explained (settled) error carrying the tx hash', async () => {
    baseSweepDbMock();
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(0n);
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('FROM sweep_transactions st')) {
        return { rowCount: 1, rows: [{ tx_hash: '0xsettledego' }] };
      }
      if (sql.includes('hot_wallet_nonces')) {
        throw new Error('UNEXPECTED: nonce touched on zero-balance path');
      }
      return { rowCount: 0, rows: [] };
    });

    try {
      await provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1']);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.name).toBe('SweepZeroBalanceError');
      expect(err.settledTxHash).toBe('0xsettledego');
    }
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  it('N. Zero balance with NO sweep history: unexplained error (worker must reconcile, not settle)', async () => {
    baseSweepDbMock();
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getBalance').mockResolvedValue(0n);
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('FROM sweep_transactions st')) {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes('hot_wallet_nonces')) {
        throw new Error('UNEXPECTED: nonce touched on zero-balance path');
      }
      return { rowCount: 0, rows: [] };
    });

    try {
      await provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'ETH', ['ps-1']);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.name).toBe('SweepZeroBalanceError');
      expect(err.settledTxHash).toBeNull();
      expect(err.message).toContain('unexplained');
    }
    expect(mockDb.transaction).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------------
  // Phase 10.4 Step 6E-5A â€” ERC20 Sweep Calldata, Gas Estimation & Signing
  // -------------------------------------------------------------------------

  it('O. ERC20 calldata encoding: deployAndSweepERC20(bytes32,address) used in gas estimation and tx params', async () => {
    const { env } = await import('../src/config/env');
    const original = env.CUSTODY_SWEEP_MIN_TOKEN_UNITS;
    (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = 'USDT=1000000';

    try {
      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM deposit_addresses')) {
          return {
            rowCount: 1,
            rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
          };
        }
        if (sql.includes('FROM asset_networks WHERE asset')) {
          return { rowCount: 1, rows: [{ contract_address: tokenContract }] };
        }
        if (sql.includes('SELECT id, network_nonce FROM sweep_intents')) {
          return { rowCount: 0, rows: [] };
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
              return { rowCount: 1, rows: [{ id: 'intent-o' }] };
            }
            return { rowCount: 0, rows: [] };
          })
        };
        return await cb(client);
      });

      vi.spyOn(ethers.JsonRpcProvider.prototype, 'call').mockResolvedValue(
        ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [5_000_000n])
      );
      vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
        maxFeePerGas: ethers.parseUnits('20', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
        gasPrice: ethers.parseUnits('20', 'gwei')
      } as any);

      let estimatedTo: string | null = null;
      let estimatedData: string | null = null;
      let estimatedFrom: string | null = null;

      vi.spyOn(ethers.JsonRpcProvider.prototype, 'estimateGas').mockImplementation(async (txParams: any) => {
        estimatedTo = txParams.to;
        estimatedData = txParams.data;
        estimatedFrom = txParams.from;
        return 120000n;
      });

      // Stop at KMS signing to inspect pre-signing calldata
      mockKms.send.mockRejectedValue(new Error('KMS_STOP'));

      await expect(
        provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'USDT', ['ps-1'])
      ).rejects.toThrow('KMS_STOP');

      const factoryIface = new ethers.Interface([
        'function deployAndSweepERC20(bytes32 salt, address token) external returns (address proxy)'
      ]);
      const expectedData = factoryIface.encodeFunctionData('deployAndSweepERC20', [salt, tokenContract]);

      expect(estimatedTo?.toLowerCase()).toBe(factoryAddress.toLowerCase());
      expect(estimatedData).toBe(expectedData);
      expect(estimatedFrom?.toLowerCase()).toBe(hotWalletAddress.toLowerCase());
    } finally {
      (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = original;
    }
  });

  it('P. ERC20 full sweep execution: gas estimation succeeds, intent+nonce reserved, KMS signs, artifact persisted, broadcast succeeds', async () => {
    const { env } = await import('../src/config/env');
    const { LocalKmsMock } = await import('../src/services/custody/local-kms-mock');
    const original = env.CUSTODY_SWEEP_MIN_TOKEN_UNITS;
    (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = 'USDT=1000000';

    try {
      const localKms = new LocalKmsMock();
      const localHotWallet = await localKms.getEthereumAddress();

      const localProvider = new KmsCustodyProvider(
        localKms as any,
        {
          'ETHEREUM': {
            rpcUrl: 'http://localhost:8545',
            keyId: 'local-test-key',
            chainId: 31337n,
            factoryAddress,
            initCodeHash
          }
        },
        mockDb
      );

      vi.spyOn(localProvider, 'getHotWalletAddress').mockResolvedValue(localHotWallet);

      mockDb.query.mockImplementation(async (sql: string) => {
        if (sql.includes('FROM deposit_addresses')) {
          return {
            rowCount: 1,
            rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
          };
        }
        if (sql.includes('FROM asset_networks WHERE asset')) {
          return { rowCount: 1, rows: [{ contract_address: tokenContract }] };
        }
        if (sql.includes('SELECT id, network_nonce FROM sweep_intents')) {
          return { rowCount: 0, rows: [] };
        }
        return { rowCount: 0, rows: [] };
      });

      vi.spyOn(ethers.JsonRpcProvider.prototype, 'call').mockResolvedValue(
        ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [10_000_000n])
      );
      vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
        maxFeePerGas: ethers.parseUnits('20', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
        gasPrice: ethers.parseUnits('20', 'gwei')
      } as any);
      vi.spyOn(ethers.JsonRpcProvider.prototype, 'estimateGas').mockResolvedValue(130000n);
      vi.spyOn(ethers.JsonRpcProvider.prototype, 'broadcastTransaction').mockResolvedValue({ hash: '0xbroadcasthash' } as any);

      let persistedRawTx: string | null = null;
      let persistedTxHash: string | null = null;

      mockDb.transaction.mockImplementation(async (cb: any) => {
        const client = {
          query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
            if (sql.includes('SELECT next_nonce FROM hot_wallet_nonces')) {
              return { rowCount: 1, rows: [{ next_nonce: '7' }] };
            }
            if (sql.includes('INSERT INTO sweep_intents')) {
              return { rowCount: 1, rows: [{ id: 'intent-erc20-1' }] };
            }
            if (sql.includes('INSERT INTO sweep_transactions')) {
              persistedTxHash = params[2];
              persistedRawTx = params[3];
              return { rowCount: 1, rows: [] };
            }
            return { rowCount: 0, rows: [] };
          })
        };
        return await cb(client);
      });

      const txHash = await localProvider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'USDT', ['ps-1', 'ps-2']);

      expect(txHash).toBe(persistedTxHash);
      expect(persistedRawTx).not.toBeNull();

      // Decode the persisted signed transaction to prove all fields
      const decoded = Transaction.from(persistedRawTx!);
      expect(decoded.from?.toLowerCase()).toBe(localHotWallet.toLowerCase());
      expect(decoded.to?.toLowerCase()).toBe(factoryAddress.toLowerCase());
      expect(decoded.nonce).toBe(7);
      expect(decoded.chainId).toBe(31337n);
      expect(decoded.value).toBe(0n);

      const factoryIface = new ethers.Interface([
        'function deployAndSweepERC20(bytes32 salt, address token) external returns (address proxy)'
      ]);
      const expectedData = factoryIface.encodeFunctionData('deployAndSweepERC20', [salt, tokenContract]);
      expect(decoded.data).toBe(expectedData);
    } finally {
      (env as any).CUSTODY_SWEEP_MIN_TOKEN_UNITS = original;
    }
  });

  it('Q. ERC20 recovery validation: fails closed if recovered calldata does not match expected ERC20 sweep', async () => {
    mockDb.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM deposit_addresses')) {
        return {
          rowCount: 1,
          rows: [{ address_metadata: { factoryAddress, salt, initCodeHash } }]
        };
      }
      if (sql.includes('FROM asset_networks WHERE asset')) {
        return { rowCount: 1, rows: [{ contract_address: tokenContract }] };
      }
      return { rowCount: 0, rows: [] };
    });

    vi.spyOn(ethers.JsonRpcProvider.prototype, 'call').mockResolvedValue(
      ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [10_000_000n])
    );
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'getFeeData').mockResolvedValue({
      maxFeePerGas: ethers.parseUnits('20', 'gwei'),
      maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      gasPrice: ethers.parseUnits('20', 'gwei')
    } as any);
    vi.spyOn(ethers.JsonRpcProvider.prototype, 'estimateGas').mockResolvedValue(130000n);

    const deterministicKey = '0x0123456789012345678901234567890123456789012345678901234567890123';
    const wallet = new ethers.Wallet(deterministicKey);
    vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue(wallet.address);

    // Create a transaction that swept ETH instead of USDT
    const factoryIface = new ethers.Interface([
      'function deployAndSweepETH(bytes32 salt) external returns (address proxy)'
    ]);
    const ethData = factoryIface.encodeFunctionData('deployAndSweepETH', [salt]);

    const tx = Transaction.from({
      to: factoryAddress,
      value: 0n,
      data: ethData, // wrong calldata for USDT sweep
      nonce: 5,
      chainId: 31337n,
      type: 2
    });
    tx.signature = wallet.signingKey.sign(tx.unsignedHash);

    mockDb.transaction.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql.includes('SELECT sweep_txid FROM pending_sweeps')) {
            return { rowCount: 1, rows: [{ sweep_txid: tx.hash }] };
          }
          if (sql.includes('SELECT tx_hash, raw_signed_tx')) {
            return {
              rowCount: 1,
              rows: [{
                tx_hash: tx.hash,
                raw_signed_tx: tx.serialized,
                network_nonce: 5
              }]
            };
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    await expect(
      provider.sweepDepositAddress('ETHEREUM', expectedCreate2, 'USDT', ['ps-1'])
    ).rejects.toThrow(/CRITICAL: Persisted raw_signed_tx calldata/);
  });
});
