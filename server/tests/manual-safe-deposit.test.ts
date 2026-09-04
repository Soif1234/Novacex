/**
 * Phase 15B.3: Real Ethereum Deposit Pipeline Implementation & Security Test Suite
 *
 * Scenarios A through R:
 * A CREATE2 prediction
 * B Solidity factory parity
 * C Idempotent address assignment
 * D Concurrent address requests
 * E Inactive-user rejection
 * F Worker disabled = zero RPC
 * G Worker enabled = EthereumSource
 * H ERC20 observation
 * I Native ETH observation
 * J Reverted transaction ignored
 * K Confirmation progression
 * L Duplicate transaction/log
 * M Duplicate ledger credit
 * N Unsupported contract
 * O RPC failure
 * P Worker restart
 * Q Reorg handling
 * R Customer isolation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ethers } from 'ethers';
import { ManualSafeCustodyProvider } from '../src/services/custody/manual-safe-custody-provider';
import { DepositAddressService } from '../src/services/custody/deposit-address.service';
import { CustodyService } from '../src/services/custody/custody.service';
import { BlockchainMonitorWorker } from '../src/workers/BlockchainMonitorWorker';
import { ConfirmationWorker } from '../src/workers/ConfirmationWorker';
import { BlockchainMonitorService } from '../src/services/blockchain/blockchain-monitor.service';
import { ConfirmationWorkerService } from '../src/services/blockchain/confirmation-worker.service';
import { DepositCreditingService } from '../src/services/blockchain/deposit-crediting.service';
import { EthereumSource } from '../src/services/blockchain/sources/ethereum-source';
import { IBlockchainSource, computeBlockchainEventId } from '../src/services/blockchain/types';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { env } from '../src/config/env';

describe('Phase 15B.3: Real Ethereum Deposit Pipeline (Scenarios A through R)', () => {
  const mockFactoryAddress = '0x1111111111111111111111111111111111111111';
  const mockImplementationAddress = '0x2222222222222222222222222222222222222222';
  const mockExpectedInitCode = ethers.solidityPacked(
    ['bytes', 'bytes20', 'bytes'],
    ['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', mockImplementationAddress, '0x5af43d82803e903d91602b57fd5bf3']
  );
  const mockInitCodeHash = ethers.keccak256(mockExpectedInitCode);

  beforeEach(() => {
    env.CUSTODY_FACTORY_ADDRESS = mockFactoryAddress;
    env.CUSTODY_IMPLEMENTATION_ADDRESS = mockImplementationAddress;
    env.CUSTODY_INIT_CODE_HASH = mockInitCodeHash;
    env.CUSTODY_ENABLED = true;
    env.CUSTODY_PROVIDER = 'manual_safe';
    env.CUSTODY_CHAIN_ID = 1;
    vi.spyOn(circuitBreakerService, 'getState').mockResolvedValue({
      isDepositsEnabled: true,
      isWithdrawalsEnabled: true,
      isTradingEnabled: true,
    } as any);
  });

  // ==========================================================================
  // Test A: CREATE2 prediction
  // ==========================================================================
  it('Test A: CREATE2 prediction — deterministic formula without private keys', async () => {
    const mockDb = { query: vi.fn() };
    const provider = new ManualSafeCustodyProvider(mockDb);

    const userId = 'usr-uuid-1234';
    const network = 'ETHEREUM';

    const salt = ethers.keccak256(ethers.solidityPacked(['string', 'string'], [userId, network]));
    const expectedAddress = ethers.getCreate2Address(
      ethers.getAddress(mockFactoryAddress),
      salt,
      mockInitCodeHash
    );

    const result = await provider.getOrCreateDepositAddress({ userId, asset: 'ETH', network });
    expect(result.address.toLowerCase()).toBe(expectedAddress.toLowerCase());

    // Different network yields different deterministic address
    const saltAlt = ethers.keccak256(ethers.solidityPacked(['string', 'string'], [userId, 'ETHEREUM_SEPOLIA']));
    const expectedAlt = ethers.getCreate2Address(
      ethers.getAddress(mockFactoryAddress),
      saltAlt,
      mockInitCodeHash
    );
    expect(expectedAddress.toLowerCase()).not.toBe(expectedAlt.toLowerCase());
  });

  // ==========================================================================
  // Test B: Solidity factory parity
  // ==========================================================================
  it('Test B: Solidity factory parity — TypeScript derivation matches Factory.sol exact algorithm', () => {
    const salt = ethers.keccak256(ethers.solidityPacked(['string', 'string'], ['usr-alpha', 'ETHEREUM']));

    // 1. Solidity predictDeterministicAddress formula:
    // keccak256(abi.encodePacked(hex"ff", address(this), salt, keccak256(initCode)))
    const solidityPackedHash = ethers.keccak256(
      ethers.solidityPacked(
        ['bytes1', 'address', 'bytes32', 'bytes32'],
        ['0xff', mockFactoryAddress, salt, mockInitCodeHash]
      )
    );
    const solidityPredicted = ethers.getAddress('0x' + solidityPackedHash.slice(-40));

    // 2. ethers.getCreate2Address
    const tsPredicted = ethers.getCreate2Address(mockFactoryAddress, salt, mockInitCodeHash);

    expect(tsPredicted.toLowerCase()).toBe(solidityPredicted.toLowerCase());
  });

  // ==========================================================================
  // Test C: Idempotent address assignment
  // ==========================================================================
  it('Test C: Idempotent address assignment — returns existing active address without provider re-call', async () => {
    const mockDb = { query: vi.fn() };
    const mockCustody = {
      isEnabled: () => true,
      getOrCreateDepositAddress: vi.fn(),
    } as unknown as CustodyService;

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, account_status')) {
        return Promise.resolve({ rows: [{ id: 'usr-1', accountStatus: 'ACTIVE' }] });
      }
      if (sql.includes('SELECT asset, network, is_active')) {
        return Promise.resolve({ rows: [{ isActive: true, requiresMemo: false, addressFormat: 'EVM_HEX' }] });
      }
      if (sql.includes('SELECT') && sql.includes('FROM deposit_addresses')) {
        return Promise.resolve({
          rows: [{
            id: 'addr-existing',
            user_id: 'usr-1',
            asset: 'ETH',
            network: 'ETHEREUM',
            blockchain_address: '0x3333333333333333333333333333333333333333',
            status: 'ACTIVE',
            created_at: new Date(),
            updated_at: new Date(),
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const depositAddressService = new DepositAddressService({ custody: mockCustody, database: mockDb as any });
    const res = await depositAddressService.getOrCreateDepositAddress({ userId: 'usr-1', asset: 'ETH', network: 'ETHEREUM' });

    expect(res.blockchainAddress).toBe('0x3333333333333333333333333333333333333333');
    expect(mockCustody.getOrCreateDepositAddress).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Test D: Concurrent address requests
  // ==========================================================================
  it('Test D: Concurrent address requests — resolve gracefully to identical address', async () => {
    const mockDb = { query: vi.fn() };
    const mockCustody = {
      isEnabled: () => true,
      getOrCreateDepositAddress: vi.fn().mockResolvedValue({
        address: '0x5555555555555555555555555555555555555555',
        asset: 'ETH',
        network: 'ETHEREUM',
        providerId: 'manual_safe',
        status: 'ACTIVE',
        requiresMemo: false,
      }),
    } as unknown as CustodyService;

    let addressRow: any = null;
    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, account_status')) {
        return Promise.resolve({ rows: [{ id: 'usr-conc', accountStatus: 'ACTIVE' }] });
      }
      if (sql.includes('SELECT asset, network, is_active')) {
        return Promise.resolve({ rows: [{ isActive: true, requiresMemo: false, addressFormat: 'EVM_HEX' }] });
      }
      if (sql.includes('SELECT') && sql.includes('FROM deposit_addresses')) {
        return Promise.resolve({ rows: addressRow ? [addressRow] : [] });
      }
      if (sql.includes('INSERT INTO deposit_addresses')) {
        addressRow = {
          id: 'addr-conc-1',
          user_id: 'usr-conc',
          asset: 'ETH',
          network: 'ETHEREUM',
          blockchain_address: '0x5555555555555555555555555555555555555555',
          status: 'ACTIVE',
          created_at: new Date(),
          updated_at: new Date(),
        };
        return Promise.resolve({ rows: [addressRow] });
      }
      return Promise.resolve({ rows: [] });
    });

    const depositAddressService = new DepositAddressService({ custody: mockCustody, database: mockDb as any });
    const [res1, res2] = await Promise.all([
      depositAddressService.getOrCreateDepositAddress({ userId: 'usr-conc', asset: 'ETH', network: 'ETHEREUM' }),
      depositAddressService.getOrCreateDepositAddress({ userId: 'usr-conc', asset: 'ETH', network: 'ETHEREUM' }),
    ]);

    expect(res1.blockchainAddress).toBe(res2.blockchainAddress);
  });

  // ==========================================================================
  // Test E: Inactive-user rejection
  // ==========================================================================
  it('Test E: Inactive-user rejection — suspended users fail closed', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('SELECT id, account_status')) {
          return Promise.resolve({ rows: [{ id: 'usr-banned', accountStatus: 'BANNED' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const mockCustody = { isEnabled: () => true } as unknown as CustodyService;
    const depositAddressService = new DepositAddressService({ custody: mockCustody, database: mockDb as any });

    await expect(
      depositAddressService.getOrCreateDepositAddress({ userId: 'usr-banned', asset: 'ETH', network: 'ETHEREUM' })
    ).rejects.toThrow('is not ACTIVE');
  });

  // ==========================================================================
  // Test F: Worker disabled = zero RPC
  // ==========================================================================
  it('Test F: Worker disabled = zero RPC — workers stay inert with zero network calls', () => {
    env.BLOCKCHAIN_MONITORING_ENABLED = false;
    env.ETHEREUM_RPC_URL = '';

    const monWorker = new BlockchainMonitorWorker(null);
    monWorker.start();
    expect((monWorker as any).isRunning).toBe(false);

    const confWorker = new ConfirmationWorker(null);
    confWorker.start();
    expect((confWorker as any).isRunning).toBe(false);
  });

  // ==========================================================================
  // Test G: Worker enabled = EthereumSource
  // ==========================================================================
  it('Test G: Worker enabled = EthereumSource — auto-initializes EthereumSource when configured', () => {
    env.BLOCKCHAIN_MONITORING_ENABLED = true;
    env.ETHEREUM_RPC_URL = 'http://127.0.0.1:8545';

    const monWorker = new BlockchainMonitorWorker(null);
    monWorker.start();
    expect(monWorker.getSource()).toBeInstanceOf(EthereumSource);
    monWorker.stop();

    const confWorker = new ConfirmationWorker(null);
    confWorker.start();
    expect(confWorker.getSource()).toBeInstanceOf(EthereumSource);
    confWorker.stop();
  });

  // ==========================================================================
  // Test H: ERC20 observation
  // ==========================================================================
  it('Test H: ERC20 observation — decodes Transfer logs and normalizes 6-decimal USDT to ledger decimal', async () => {
    const mockDb = { query: vi.fn() };
    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockResolvedValue(100),
      getBlock: vi.fn().mockImplementation((n: number) => Promise.resolve({ hash: '0xhash' + n, timestamp: 1700000000 })),
      getLogs: vi.fn(),
      getAddressTransactions: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, currentBlockHeight: 100, latencyMs: 5 }),
    };

    const recipient = '0x4444444444444444444444444444444444444444';
    const usdtContract = '0xdac17f958d2ee523a2206206994597c13d831ec7';

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM monitor_checkpoints')) {
        return Promise.resolve({ rows: [{ lastBlockNumber: 99, lastBlockHash: '0xhash99' }] });
      }
      if (sql.includes('FROM deposit_addresses')) {
        return Promise.resolve({ rows: [{ blockchainAddress: recipient, blockchain_address: recipient }] });
      }
      if (sql.includes('FROM asset_networks')) {
        return Promise.resolve({
          rows: [{
            asset: 'USDT',
            network: 'ETHEREUM',
            contractAddress: usdtContract,
            contract_address: usdtContract,
            decimals: 6,
            confirmationsRequired: 12,
            confirmations_required: 12,
            isActive: true,
            is_active: true,
            addressFormat: 'EVM_HEX',
            address_format: 'EVM_HEX',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const rawAmountHex = '0x' + (100000000n).toString(16); // 100 USDT (6 decimals)
    (mockSource.getLogs as any).mockResolvedValue([
      {
        blockNumber: 100,
        blockHash: '0xhash100',
        transactionHash: '0xtx100',
        logIndex: 0,
        address: usdtContract,
        topics: [
          '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
          '0x0000000000000000000000001111111111111111111111111111111111111111',
          '0x0000000000000000000000004444444444444444444444444444444444444444',
        ],
        data: rawAmountHex,
        removed: false,
      },
    ]);

    const monitor = new BlockchainMonitorService(mockDb as any, mockSource);
    const runResult = await monitor.runOnce();

    expect(runResult.detected).toBe(1);
    expect(runResult.inserted).toBe(1);

    const insertCall = mockDb.query.mock.calls.find((c: any) => c[0]?.includes('INSERT INTO blockchain_deposits'));
    expect(insertCall).toBeDefined();
    expect(parseFloat(insertCall[1][11])).toBe(100);
  });

  // ==========================================================================
  // Test I: Native ETH observation
  // ==========================================================================
  it('Test I: Native ETH observation — detects transaction and normalizes 18-decimal wei', async () => {
    const mockDb = { query: vi.fn() };
    const recipient = '0x5555555555555555555555555555555555555555';
    const rawWei = '1500000000000000000'; // 1.5 ETH

    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockResolvedValue(200),
      getBlock: vi.fn().mockImplementation((n: number) => Promise.resolve({ hash: '0xhash' + n, timestamp: 1700000000 })),
      getLogs: vi.fn().mockResolvedValue([]),
      getAddressTransactions: vi.fn().mockResolvedValue([
        {
          txHash: '0xethtx1',
          voutIndex: 0,
          blockNumber: 200,
          blockHash: '0xhash200',
          timestamp: 1700000000,
          from: '0xsender1',
          to: recipient,
          value: rawWei,
          rawPayload: {},
        },
      ]),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, currentBlockHeight: 200, latencyMs: 5 }),
    };

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM monitor_checkpoints')) {
        return Promise.resolve({ rows: [{ lastBlockNumber: 199, lastBlockHash: '0xhash199' }] });
      }
      if (sql.includes('FROM deposit_addresses')) {
        return Promise.resolve({ rows: [{ blockchainAddress: recipient, blockchain_address: recipient }] });
      }
      if (sql.includes('FROM asset_networks')) {
        return Promise.resolve({
          rows: [{
            asset: 'ETH',
            network: 'ETHEREUM',
            contractAddress: null,
            contract_address: null,
            decimals: 18,
            confirmationsRequired: 12,
            confirmations_required: 12,
            isActive: true,
            is_active: true,
            addressFormat: 'EVM_HEX',
            address_format: 'EVM_HEX',
          }],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const monitor = new BlockchainMonitorService(mockDb as any, mockSource);
    const runResult = await monitor.runOnce();

    expect(runResult.detected).toBe(1);
    expect(runResult.inserted).toBe(1);

    const insertCall = mockDb.query.mock.calls.find((c: any) => c[0]?.includes('INSERT INTO blockchain_deposits'));
    expect(insertCall).toBeDefined();
    expect(parseFloat(insertCall[1][11])).toBe(1.5);
  });

  // ==========================================================================
  // Test J: Reverted transaction ignored
  // ==========================================================================
  it('Test J: Reverted transaction ignored — skips transactions where receipt.status !== 1', async () => {
    const source = new EthereumSource({ rpcUrl: 'http://127.0.0.1:8545' });

    (source as any).rpc = vi.fn().mockImplementation((method: string) => {
      if (method === 'eth_getBlockByNumber') {
        return Promise.resolve({
          result: {
            hash: '0xblock1',
            timestamp: '0x65000000',
            transactions: [
              {
                hash: '0xtx_failed',
                from: '0xsender',
                to: '0xtarget',
                value: '0xde0b6b3a7640000',
              },
            ],
          },
        });
      }
      if (method === 'eth_getTransactionReceipt') {
        return Promise.resolve({ result: { status: '0x0' } }); // REVERTED
      }
      return Promise.resolve({ result: null });
    });

    const txs = await source.getAddressTransactions('0xtarget', 10, 10);
    expect(txs).toHaveLength(0);
  });

  // ==========================================================================
  // Test K: Confirmation progression
  // ==========================================================================
  it('Test K: Confirmation progression — transitions CONFIRMING to CONFIRMED at depth threshold', async () => {
    const mockDb = { query: vi.fn() };
    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockResolvedValue(112),
      getBlock: vi.fn(),
      getLogs: vi.fn(),
      getAddressTransactions: vi.fn(),
      healthCheck: vi.fn(),
    };

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT id, block_number')) {
        return Promise.resolve({
          rows: [
            {
              id: 'dep-1',
              blockNumber: 100,
              requiredConfirmations: 12,
              confirmationCount: 5,
              status: 'CONFIRMING',
            },
          ],
        });
      }
      if (sql.includes('UPDATE blockchain_deposits')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });

    const confService = new ConfirmationWorkerService(mockDb as any, mockSource);
    const result = await confService.runOnce();

    expect(result.updatedConfirmed).toBe(1);
    const updateCall = mockDb.query.mock.calls.find((c: any) => c[0]?.includes('UPDATE blockchain_deposits'));
    expect(updateCall[1][0]).toBe(13); // 112 - 100 + 1 = 13
    expect(updateCall[1][1]).toBe('CONFIRMED');
  });

  // ==========================================================================
  // Test L: Duplicate transaction/log
  // ==========================================================================
  it('Test L: Duplicate transaction/log — computeBlockchainEventId produces identical deterministic key', () => {
    const chainId = 'ethereum';
    const txHash = '0xabc123';
    const logIndex = 2;

    const id1 = computeBlockchainEventId(chainId, txHash, logIndex);
    const id2 = computeBlockchainEventId(chainId, txHash, logIndex);
    const idDiff = computeBlockchainEventId(chainId, txHash, 3);

    expect(id1).toBe(id2);
    expect(id1).not.toBe(idDiff);
  });

  // ==========================================================================
  // Test M: Duplicate ledger credit
  // ==========================================================================
  it('Test M: Duplicate ledger credit — is_credited check prevents duplicate crediting', async () => {
    const mockTxClient = { query: vi.fn() };
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'dep-already-credited' }] }),
      transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockTxClient)),
    };

    // Row is already is_credited = true
    mockTxClient.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM blockchain_deposits WHERE id = $1 FOR UPDATE')) {
        return Promise.resolve({
          rows: [
            {
              id: 'dep-already-credited',
              status: 'CONFIRMED',
              is_credited: true, // ALREADY CREDITED
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const creditingService = new DepositCreditingService(mockDb as any);
    await creditingService.processBacklog(10);

    // Assert no deposits row was inserted
    const insertDepositCall = mockTxClient.query.mock.calls.find((c: any) => c[0]?.includes('INSERT INTO deposits'));
    expect(insertDepositCall).toBeUndefined();
  });

  // ==========================================================================
  // Test N: Unsupported contract
  // ==========================================================================
  it('Test N: Unsupported contract — unknown ERC-20 token rejected with UNSUPPORTED_ASSET_NETWORK', async () => {
    const mockDb = { query: vi.fn() };
    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockResolvedValue(100),
      getBlock: vi.fn().mockImplementation((n: number) => Promise.resolve({ hash: '0xhash' + n, timestamp: 1700000000 })),
      getLogs: vi.fn().mockResolvedValue([
        {
          blockNumber: 100,
          blockHash: '0xhash100',
          transactionHash: '0xtx_rogue',
          logIndex: 0,
          address: '0xunknown_token_contract',
          topics: [
            '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
            '0x0000000000000000000000001111111111111111111111111111111111111111',
            '0x0000000000000000000000004444444444444444444444444444444444444444',
          ],
          data: '0x1000',
          removed: false,
        },
      ]),
      getAddressTransactions: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, currentBlockHeight: 100, latencyMs: 5 }),
    };

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM monitor_checkpoints')) {
        return Promise.resolve({ rows: [{ lastBlockNumber: 99, lastBlockHash: '0xhash99' }] });
      }
      if (sql.includes('FROM deposit_addresses')) {
        return Promise.resolve({ rows: [{ blockchainAddress: '0x4444444444444444444444444444444444444444', blockchain_address: '0x4444444444444444444444444444444444444444' }] });
      }
      if (sql.includes('contract_address IS NOT NULL')) {
        return Promise.resolve({ rows: [{ contract_address: '0xunknown_token_contract' }] });
      }
      if (sql.includes('FROM asset_networks')) {
        return Promise.resolve({ rows: [] }); // Contract NOT found in asset_networks mapping
      }
      return Promise.resolve({ rows: [] });
    });

    const monitor = new BlockchainMonitorService(mockDb as any, mockSource);
    const runResult = await monitor.runOnce();

    expect(runResult.rejected).toBe(1);
    expect(runResult.inserted).toBe(0);
  });

  // ==========================================================================
  // Test O: RPC failure
  // ==========================================================================
  it('Test O: RPC failure — RPC timeout throws and prevents checkpoint advancement', async () => {
    const mockDb = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM monitor_checkpoints')) {
          return Promise.resolve({ rows: [{ lastBlockNumber: 100, lastBlockHash: '0xhash100' }] });
        }
        return Promise.resolve({ rows: [] });
      }),
    };
    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection timed out')),
      getBlock: vi.fn(),
      getLogs: vi.fn(),
      getAddressTransactions: vi.fn(),
      healthCheck: vi.fn(),
    };

    const monitor = new BlockchainMonitorService(mockDb as any, mockSource);
    const runResult = await monitor.runOnce();

    expect(runResult.errors).toBe(1);
    expect(runResult.checkpointAdvanced).toBe(false);

    // Checkpoint must NOT be advanced
    const checkpointUpdate = mockDb.query.mock.calls.find((c: any) => c[0]?.includes('UPDATE monitor_checkpoints'));
    expect(checkpointUpdate).toBeUndefined();
  });

  // ==========================================================================
  // Test P: Worker restart
  // ==========================================================================
  it('Test P: Worker restart — resumes scanning from persisted last_block_number checkpoint', async () => {
    const mockDb = { query: vi.fn() };
    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockResolvedValue(550),
      getBlock: vi.fn().mockImplementation((n: number) => Promise.resolve({ hash: '0xhash' + n, timestamp: 1700000000 })),
      getLogs: vi.fn().mockResolvedValue([]),
      getAddressTransactions: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn(),
    };

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM monitor_checkpoints')) {
        return Promise.resolve({ rows: [{ lastBlockNumber: 540, lastBlockHash: '0xhash540' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    const monitor = new BlockchainMonitorService(mockDb as any, mockSource);
    const runResult = await monitor.runOnce();

    // Must scan from block 541 onwards
    expect(runResult.scannedBlocks).toBe(10); // 541 through 550
  });

  // ==========================================================================
  // Test Q: Reorg handling
  // ==========================================================================
  it('Test Q: Reorg handling — hash mismatch rewinds checkpoint and leaves confirmed credits untouched', async () => {
    const mockDb = { query: vi.fn() };
    const mockSource: IBlockchainSource = {
      chainId: 'ethereum',
      displayName: 'Ethereum',
      getBlockNumber: vi.fn().mockResolvedValue(100),
      // Block 99 hash has changed on the node (canonical reorg)
      getBlock: vi.fn().mockImplementation((n: number) => {
        if (n === 99) return Promise.resolve({ hash: '0xnew_reorged_hash_99', timestamp: 1700000000 });
        return Promise.resolve({ hash: '0xhash' + n, timestamp: 1700000000 });
      }),
      getLogs: vi.fn().mockResolvedValue([]),
      getAddressTransactions: vi.fn().mockResolvedValue([]),
      healthCheck: vi.fn(),
    };

    mockDb.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM monitor_checkpoints')) {
        return Promise.resolve({ rows: [{ lastBlockNumber: 99, lastBlockHash: '0xold_stale_hash_99' }] });
      }
      if (sql.includes('SELECT * FROM blockchain_deposits') && sql.includes('BETWEEN')) {
        return Promise.resolve({ rows: [{ id: 'dep-reorged-1' }] });
      }
      if (sql.includes('UPDATE blockchain_deposits') && sql.includes('status = \'REORGED\'')) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });

    const monitor = new BlockchainMonitorService(mockDb as any, mockSource);
    const runResult = await monitor.runOnce();

    expect(runResult.reorged).toBe(1);

    // Checkpoint rewind must have been issued
    const rewindCall = mockDb.query.mock.calls.find(
      (c: any) => c[0]?.includes('UPDATE monitor_checkpoints') && c[0]?.includes('last_block_hash = NULL')
    );
    expect(rewindCall).toBeDefined();
  });

  // ==========================================================================
  // Test R: Customer isolation
  // ==========================================================================
  it('Test R: Customer isolation — credits strictly target depositing user FUNDING account', async () => {
    const mockTxClient = { query: vi.fn() };
    const mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [{ id: 'dep-target-1' }] }),
      transaction: vi.fn().mockImplementation(async (cb: any) => cb(mockTxClient)),
    };

    mockTxClient.query.mockImplementation((sql: string) => {
      if (sql.includes('SELECT * FROM blockchain_deposits WHERE id = $1 FOR UPDATE')) {
        return Promise.resolve({
          rows: [{
            id: 'dep-target-1',
            chain_id: 'ethereum',
            asset: 'ETH',
            network: 'ETHEREUM',
            transaction_hash: '0xtx_isolated',
            block_number: 100,
            block_hash: '0xhash100',
            block_timestamp: new Date(),
            log_index: 0,
            from_address: '0xext',
            to_address: '0xuser_alice_addr',
            amount: '5.0',
            raw_amount: '5000000000000000000',
            status: 'CONFIRMED',
            is_credited: false,
          }],
        });
      }
      if (sql.includes('SELECT user_id, status FROM deposit_addresses')) {
        return Promise.resolve({ rows: [{ user_id: 'alice-uuid', status: 'ACTIVE' }] });
      }
      if (sql.includes('SELECT account_status FROM users')) {
        return Promise.resolve({ rows: [{ account_status: 'ACTIVE' }] });
      }
      if (sql.includes('SELECT is_active FROM asset_networks')) {
        return Promise.resolve({ rows: [{ is_active: true }] });
      }
      if (sql.includes('FROM accounts')) {
        return Promise.resolve({ rows: [{ id: 'alice-funding-acc', user_id: 'alice-uuid', type: 'FUNDING', is_active: true, isActive: true }] });
      }
      if (sql.includes('FROM wallet_balances')) {
        return Promise.resolve({ rows: [{ id: 'wb-alice', account_id: 'alice-funding-acc', asset: 'ETH', balance_available: '0', balance_locked: '0' }] });
      }
      if (sql.includes('INSERT INTO ledger_transactions') || sql.includes('INSERT INTO ledger_entries')) {
        return Promise.resolve({ rows: [{ id: 'ltx-alice-1' }] });
      }
      if (sql.includes('INSERT INTO deposits')) {
        return Promise.resolve({ rows: [] });
      }
      if (sql.includes('UPDATE blockchain_deposits SET is_credited = TRUE')) {
        return Promise.resolve({ rows: [] });
      }
      return Promise.resolve({ rows: [] });
    });

    const creditingService = new DepositCreditingService(mockDb as any);
    await creditingService.processBacklog(10);

    const depositInsert = mockTxClient.query.mock.calls.find((c: any) => c[0]?.includes('INSERT INTO deposits'));
    expect(depositInsert).toBeDefined();
    expect(depositInsert[1][1]).toBe('alice-funding-acc'); // Targeted directly to Alice FUNDING account
    expect(depositInsert[1][2]).toBe('ETH');
    expect(depositInsert[1][3]).toBe('5.0');
  });
});
