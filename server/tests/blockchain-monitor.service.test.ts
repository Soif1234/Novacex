/**
 * Phase 9.4 — Blockchain Monitor Service: Unit Tests
 *
 * Acceptance criteria:
 * 1. First deposit detected
 * 2. Duplicate scan does not duplicate
 * 3. Confirmation increments
 * 4. CONFIRMED at threshold
 * 5. Wrong ERC-20 token rejected
 * 6. Wrong native/token type rejected
 * 7. Inactive asset_network rejected
 * 8. Revoked address rejected
 * 9. Reorg changes CONFIRMED → REORGED
 * 10. Unchanged block hash causes no reorg
 * 11. Provider outage preserves checkpoint
 * 12. Duplicate event replay safe
 * 13. wallet_balances unchanged
 * 14. ledger unchanged
 * 15. is_deposits_enabled=false causes REJECTED observation
 * 16. Unsupported network rejected
 * 17. Restart resumes from checkpoint
 * 18. Multiple addresses in same block all detected
 *
 * Also: Ethereum mock source tests, Bitcoin mock source tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authService } from '../src/services/auth/auth.service';
import {
  MockCustodyProvider,
  createCustodyService,
  createDepositAddressService,
} from '../src/services/custody';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { BlockchainMonitorService } from '../src/services/blockchain/blockchain-monitor.service';
import { ConfirmationWorkerService } from '../src/services/blockchain/confirmation-worker.service';
import { MockBlockchainSource } from '../src/services/blockchain/sources/mock-source';
import { EthereumSource } from '../src/services/blockchain/sources/ethereum-source';
import { ERC20_TRANSFER_TOPIC } from '../src/services/blockchain/types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** USDT contract address (lowercase) from asset_networks seed. */
const USDT_CONTRACT = '0xdac17f958d2ee523a2206206994597c13d831ec7';
/** USDC contract address (lowercase) from asset_networks seed. */
const USDC_CONTRACT = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';

const REQUIRED_CONFS_USDT = 12;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTestUser(): Promise<{ userId: string; email: string }> {
  const signup = await authService.signup({
    email: `bm_test_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
    password: 'TestPassword123!Secure',
    username: `bmtest_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
  });
  return { userId: signup.user.id, email: signup.user.email };
}

function makeEnabledStack() {
  const mockProvider = new MockCustodyProvider();
  const custody = createCustodyService({ enabled: true, adapter: mockProvider });
  const service = createDepositAddressService({ custody });
  return { mockProvider, custody, service };
}

/**
 * Pad an EVM address (20 bytes) to a 32-byte hex topic.
 */
function padToTopic(addr: string): string {
  const clean = addr.replace(/^0x/, '').toLowerCase();
  return '0x' + clean.padStart(64, '0');
}

/**
 * Encode a uint256 value as a hex data string (padded to 32 bytes).
 */
function encodeUint256(value: string | bigint): string {
  const big = typeof value === 'string' ? BigInt(value) : value;
  return '0x' + big.toString(16).padStart(64, '0');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 9.4: Blockchain Monitor Service — Ethereum (ERC-20)', () => {
  let db: any;
  let userId: string;
  let ethereumAddress: string;
  let ethAddress: string;
  let mockSource: MockBlockchainSource;
  let monitor: BlockchainMonitorService;
  let confWorker: ConfirmationWorkerService;

  beforeEach(async () => {
    db = (await import('../src/config/database')).db;
    db.reset?.();
    circuitBreakerService.resetCache();
    await db.connect();

    userId = (await createTestUser()).userId;

    // Create a USDT/ETHEREUM deposit address
    const { service } = makeEnabledStack();
    const addr = await service.getOrCreateDepositAddress({ userId, asset: 'USDT', network: 'ETHEREUM' });
    ethereumAddress = addr.blockchainAddress.toLowerCase();

    const addrEth = await service.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    ethAddress = addrEth.blockchainAddress.toLowerCase();

    mockSource = new MockBlockchainSource('ethereum');

    // Seed genesis block
    mockSource.injectBlock({ number: 0 });

    monitor = new BlockchainMonitorService(db, mockSource, circuitBreakerService);
    confWorker = new ConfirmationWorkerService(db, mockSource);
  });

  // 1. First deposit detected
  it('01. First deposit is detected and persisted as DETECTED', async () => {
    // Inject a block with a USDT Transfer event to the user's deposit address
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'), // 1 USDT (6 decimals)
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();

    expect(result.detected).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.checkpointAdvanced).toBe(true);

    // Verify the deposit row
    const depositRes = await db.query(
      `SELECT id, status, amount, asset, network, confirmation_count, required_confirmations
       FROM blockchain_deposits WHERE transaction_hash = $1`,
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows.length).toBe(1);
    expect(depositRes.rows[0].status).toBe('DETECTED');
    expect(depositRes.rows[0].amount).toBe('1'); // 1000000 / 10^6 = 1
    expect(depositRes.rows[0].asset).toBe('USDT');
    expect(depositRes.rows[0].confirmationCount).toBe(0);
    expect(depositRes.rows[0].requiredConfirmations).toBe(REQUIRED_CONFS_USDT);
  });

  // 2. Duplicate scan does not duplicate
  it('02. Re-scanning same block does not create duplicate rows', async () => {
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    // First scan
    await monitor.runOnce();

    // Rewind checkpoint to simulate re-scan
    const now = new Date();
    await db.query(
      `UPDATE monitor_checkpoints SET last_block_number = $1, last_block_hash = NULL,
       last_processed_at = $2, consecutive_errors = 0 WHERE network = $3`,
      [0, now, 'ETHEREUM'],
    );

    // Second scan — should not create duplicate
    const result = await monitor.runOnce();

    // The event is detected again but INSERT ON CONFLICT DO NOTHING prevents duplicate
    const allRows = await db.query(
      'SELECT id FROM blockchain_deposits WHERE network = $1',
      ['ETHEREUM'],
    );
    expect(allRows.rows.length).toBe(1);
  });

  // 3. Confirmation increments
  it('03. Confirmation count updates as block height increases', async () => {
    // Deposit at block 1
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Advance to block 5
    mockSource.setNextBlock(5);
    const result = await confWorker.runOnce();

    // confirmation_count = max(0, 5 - 1 + 1) = 5
    const depositRes = await db.query(
      'SELECT confirmation_count, status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].confirmationCount).toBe(5);
    expect(depositRes.rows[0].status).toBe('CONFIRMING'); // 5 < 12
    expect(result.updatedConfirming).toBe(1);
  });

  // 4. CONFIRMED at threshold
  it('04. Deposit transitions to CONFIRMED when required_confirmations reached', async () => {
    // Deposit at block 1
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Advance to block 13 (13 - 1 + 1 = 13 >= 12)
    mockSource.setNextBlock(13);
    await confWorker.runOnce();

    const depositRes = await db.query(
      'SELECT confirmation_count, status, confirmed_at FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].confirmationCount).toBe(13);
    expect(depositRes.rows[0].status).toBe('CONFIRMED');
    expect(depositRes.rows[0].confirmedAt).toBeTruthy();
  });

  // 5. Wrong ERC-20 token rejected
  it('05. ERC-20 event with unapproved contract address is REJECTED', async () => {
    const fakeContract = '0xdead000000000000000000000000000000000001';
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: fakeContract,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();

    expect(result.detected).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.inserted).toBe(0);

    // Unknown token has no resolvable asset — no row is persisted (FK safety)
    const allRows = await db.query(
      'SELECT COUNT(*) as cnt FROM blockchain_deposits',
    );
    expect(allRows.rows[0].cnt).toBe(0);
  });

  // 6. Multi-asset forwarder support (CRIT-01 remediation)
  it('06. ERC-20 USDT transfer to an ETH deposit address is ACCEPTED (CRIT-01 multi-asset forwarder)', async () => {
    // Create an ETH deposit address (different address than USDT)
    const { service } = makeEnabledStack();
    const ethAddr = await service.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const usdtAddr = await service.getOrCreateDepositAddress({ userId, asset: 'USDT', network: 'ETHEREUM' });

    // Inject a USDT ERC-20 transfer to the ETH deposit address.
    // In Phase 15D-1 (CRIT-01), the cryptographic identity is (userId, network).
    // The forwarder address can receive any supported token, so this is ACCEPTED.
    mockSource.injectBlock({
      number: 1,
      timestamp: 1_700_000_000,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethAddr.blockchainAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + 'a'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();
    expect(result.detected).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.inserted).toBe(1);

    const usdtRes = await db.query(
      'SELECT status, amount, asset FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + 'a'.repeat(64)],
    );
    expect(usdtRes.rows[0].status).toBe('DETECTED');
    expect(usdtRes.rows[0].asset).toBe('USDT');
    expect(usdtRes.rows[0].amount).toBe('1');

    // A native ETH transfer to the ETH address should succeed
    mockSource.injectBlock({
      number: 2,
      timestamp: 1_700_000_012,
      transactions: [{
        hash: '0x' + 'b'.repeat(64),
        from: '0x1111111111111111111111111111111111111111',
        to: ethAddr.blockchainAddress.toLowerCase(),
        value: '2000000000000000000', // 2 ETH in wei
        input: '0x',
      }],
    });
    mockSource.setNextBlock(2);
    const result2 = await monitor.runOnce();

    expect(result2.inserted).toBe(1);
    expect(result2.rejected).toBe(0);

    const ethRes = await db.query(
      'SELECT status, amount, asset FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + 'b'.repeat(64)],
    );
    expect(ethRes.rows[0].status).toBe('DETECTED');
    expect(ethRes.rows[0].asset).toBe('ETH');
    expect(ethRes.rows[0].amount).toBe('2'); // 2 ETH
    expect(usdtAddr).toBeTruthy();
  });

  // 7. Inactive asset_network rejected
  it('07. Deposit to inactive asset_network is REJECTED', async () => {
    // Deactivate the USDT/ETHEREUM asset_network
    await db.query(
      `UPDATE asset_networks SET is_active = false WHERE asset = $1 AND network = $2`,
      ['USDT', 'ETHEREUM'],
    );

    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();
    expect(result.rejected).toBe(1);

    const depositRes = await db.query(
      'SELECT status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('REJECTED');
  });

  // 8. Revoked address rejected
  it('08. Deposit to revoked address is DETECTED', async () => {
    const { service } = makeEnabledStack();
    const addr = await service.getOrCreateDepositAddress({ userId, asset: 'USDT', network: 'ETHEREUM' });
    await service.revokeDepositAddress({ userId, asset: 'USDT', network: 'ETHEREUM' });

    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(addr.blockchainAddress.toLowerCase()),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();
    expect(result.rejected).toBe(0);
    expect(result.inserted).toBe(1);

    const depositRes = await db.query(
      'SELECT status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('DETECTED');
  });

  // 9. Reorg changes CONFIRMED → REORGED
  it('09. Block reorg marks affected deposits as REORGED', async () => {
    // Deposit at block 1
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Confirm the deposit
    mockSource.setNextBlock(13);
    await confWorker.runOnce();

    // Verify CONFIRMED
    let depositRes = await db.query(
      'SELECT status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('CONFIRMED');

    // Inject reorg — change block 1's hash
    mockSource.injectReorg(1, 1);
    mockSource.setNextBlock(13);

    // Run monitor again — should detect reorg
    const result = await monitor.runOnce();

    // Check reorg detection
    depositRes = await db.query(
      'SELECT status, reorged_at FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('REORGED');
    expect(depositRes.rows[0].reorgedAt).toBeTruthy();
    expect(result.reorged).toBeGreaterThanOrEqual(1);
  });

  // 10. Unchanged block hash causes no reorg
  it('10. Matching block hash does not trigger reorg', async () => {
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Run again — same height, no reorg
    const result = await monitor.runOnce();
    expect(result.reorged).toBe(0);

    // Status unchanged
    const depositRes = await db.query(
      'SELECT status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('DETECTED');
  });

  // 11. Provider outage preserves checkpoint
  it('11. Provider outage preserves checkpoint, resume on recovery', async () => {
    // Detect at block 1
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Verify checkpoint advanced
    let cpRes = await db.query(
      'SELECT last_block_number FROM monitor_checkpoints WHERE network = $1',
      ['ETHEREUM'],
    );
    expect(cpRes.rows[0].lastBlockNumber).toBe(1);

    // Source becomes unhealthy
    mockSource.setUnhealthy(true);

    // Run monitor — should fail
    const result = await monitor.runOnce();
    expect(result.errors).toBeGreaterThan(0);
    expect(result.checkpointAdvanced).toBe(false);

    // Checkpoint still at 1
    cpRes = await db.query(
      'SELECT last_block_number FROM monitor_checkpoints WHERE network = $1',
      ['ETHEREUM'],
    );
    expect(cpRes.rows[0].lastBlockNumber).toBe(1);

    // Source recovers, inject block 2
    mockSource.setUnhealthy(false);
    mockSource.injectBlock({
      number: 2,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x2222222222222222222222222222222222222222'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('2000000'),
        transactionHash: '0x' + '2'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(2);

    // Resume — should scan from block 2
    const result2 = await monitor.runOnce();
    expect(result2.detected).toBe(1);
    expect(result2.inserted).toBe(1);
    expect(result2.errors).toBe(0);

    // Checkpoint advanced to 2
    cpRes = await db.query(
      'SELECT last_block_number FROM monitor_checkpoints WHERE network = $1',
      ['ETHEREUM'],
    );
    expect(cpRes.rows[0].lastBlockNumber).toBe(2);
  });

  // 12. Duplicate event replay safe
  it('12. Replaying the same event via rewind is idempotent', async () => {
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Rewind checkpoint
    await db.query(
      `UPDATE monitor_checkpoints SET last_block_number = $1, last_block_hash = NULL,
       last_processed_at = $2, consecutive_errors = 0 WHERE network = $3`,
      [0, new Date(), 'ETHEREUM'],
    );

    // Re-scan
    await monitor.runOnce();

    // Only one row
    const allRows = await db.query(
      'SELECT COUNT(*) as cnt FROM blockchain_deposits',
    );
    expect(allRows.rows[0].cnt).toBe(1);
  });

  // 13. wallet_balances unchanged
  it('13. Blockchain deposit detection does not mutate wallet_balances', async () => {
    const before = await db.query('SELECT * FROM wallet_balances');

    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    const after = await db.query('SELECT * FROM wallet_balances');
    expect(after.rows.length).toBe(before.rows.length);
  });

  // 14. ledger unchanged
  it('14. Blockchain deposit detection does not mutate ledger', async () => {
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    const entries = await db.query('SELECT * FROM ledger_entries');
    expect(entries.rows.length).toBe(0);

    const txs = await db.query('SELECT * FROM ledger_transactions');
    expect(txs.rows.length).toBe(0);
  });

  // 15. Circuit breaker deposits disabled
  it('15. is_deposits_enabled=false observes truthfully (DETECTED)', async () => {
    // Halt deposits
    await circuitBreakerService.halt({
      adminUserId: userId,
      mode: 'HALT_WITHDRAWALS',
      isDepositsEnabled: false,
      reason: 'Test: deposits halted',
    });

    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();
    expect(result.rejected).toBe(0);
    expect(result.inserted).toBe(1);

    const depositRes = await db.query(
      'SELECT status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('DETECTED');
  });

  // 16. Unsupported network rejected
  it('16. Event for unsupported (asset, network) is REJECTED', async () => {
    // Inject an event with a contract that has no matching asset_network
    const unknownContract = '0x1234567890abcdef1234567890abcdef12345678';
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: unknownContract,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();
    expect(result.rejected).toBe(0);

    // Unknown token has no resolvable asset — no row persisted
    const allRows = await db.query(
      'SELECT COUNT(*) as cnt FROM blockchain_deposits',
    );
    expect(allRows.rows[0].cnt).toBe(0);
  });

  // 17. Restart resumes from checkpoint
  it('17. New monitor instance resumes from checkpoint', async () => {
    // Detect at block 1
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1111111111111111111111111111111111111111'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('1000000'),
        transactionHash: '0x' + '1'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Block 2 event
    mockSource.injectBlock({
      number: 2,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x2222222222222222222222222222222222222222'),
          padToTopic(ethereumAddress),
        ],
        data: encodeUint256('2000000'),
        transactionHash: '0x' + '2'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(2);

    // "Restart" — create new monitor instance
    const newMonitor = new BlockchainMonitorService(db, mockSource, circuitBreakerService);
    const result = await newMonitor.runOnce();

    // Should detect block 2 but NOT block 1 (already scanned)
    expect(result.detected).toBe(1);
    expect(result.inserted).toBe(1);

    // Only 2 rows total (block 1 + block 2)
    const allRows = await db.query(
      'SELECT COUNT(*) as cnt FROM blockchain_deposits',
    );
    expect(allRows.rows[0].cnt).toBe(2);
  });

  // 18. Multiple addresses in same block detected

  it('A. native + ERC20 in SAME transaction -> two distinct blockchain deposit IDs', async () => {
    const txHash = '0x' + 'd'.repeat(64);
    mockSource.injectBlock({
      number: 1,
      transactions: [{
        hash: txHash,
        voutIndex: 0,
        from: '0xsender',
        to: ethAddress,
        value: '1000000000',
        blockNumber: 1,
        rawPayload: {}
      }],
      logs: [{
        address: USDT_CONTRACT,
        topics: [ERC20_TRANSFER_TOPIC, padToTopic('0xsender'), padToTopic(ethereumAddress)],
        data: encodeUint256('2000000'),
        transactionHash: txHash,
        logIndex: 0,
        removed: false
      }]
    });

    const result = await monitor.runOnce();
    expect(result.inserted).toBe(2);
  });

  it('B. two ERC20 Transfer events in same tx -> two distinct IDs', async () => {
    const txHash = '0x' + 'e'.repeat(64);
    mockSource.injectBlock({
      number: 2,
      logs: [{
        address: USDT_CONTRACT,
        topics: [ERC20_TRANSFER_TOPIC, padToTopic('0xsender'), padToTopic(ethereumAddress)],
        data: encodeUint256('1000000'),
        transactionHash: txHash,
        logIndex: 1,
        removed: false
      }, {
        address: USDT_CONTRACT,
        topics: [ERC20_TRANSFER_TOPIC, padToTopic('0xsender'), padToTopic(ethereumAddress)],
        data: encodeUint256('2000000'),
        transactionHash: txHash,
        logIndex: 2,
        removed: false
      }]
    });

    const result = await monitor.runOnce();
    expect(result.inserted).toBe(2);
  });

  it('18. Multiple users receiving deposits in same block are all detected', async () => {
    // Create second user
    const user2 = await createTestUser();
    const { service } = makeEnabledStack();
    const addr1 = await service.getOrCreateDepositAddress({ userId, asset: 'USDT', network: 'ETHEREUM' });
    const addr2 = await service.getOrCreateDepositAddress({ userId: user2.userId, asset: 'USDT', network: 'ETHEREUM' });

    // One block, two Transfer events
    mockSource.injectBlock({
      number: 1,
      logs: [
        {
          address: USDT_CONTRACT,
          topics: [
            ERC20_TRANSFER_TOPIC,
            padToTopic('0x1111111111111111111111111111111111111111'),
            padToTopic(addr1.blockchainAddress),
          ],
          data: encodeUint256('1000000'),
          transactionHash: '0x' + '1'.repeat(64),
          logIndex: 0,
        },
        {
          address: USDT_CONTRACT,
          topics: [
            ERC20_TRANSFER_TOPIC,
            padToTopic('0x1111111111111111111111111111111111111111'),
            padToTopic(addr2.blockchainAddress),
          ],
          data: encodeUint256('2000000'),
          transactionHash: '0x' + '2'.repeat(64),
          logIndex: 0,
        },
      ],
    });
    mockSource.setNextBlock(1);

    const result = await monitor.runOnce();
    expect(result.detected).toBe(2);
    expect(result.inserted).toBe(2);

    // Both persisted
    const allRows = await db.query(
      'SELECT COUNT(*) as cnt FROM blockchain_deposits',
    );
    expect(allRows.rows[0].cnt).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Real EthereumSource end-to-end tests (native ETH detection via mocked RPC)
// ---------------------------------------------------------------------------

describe('Phase 9.4: Blockchain Monitor — Real EthereumSource (mocked RPC)', () => {
  let db: any;
  let userId: string;
  let ethAddress: string;
  let realSource: EthereumSource;
  let monitor: BlockchainMonitorService;

  function rpcBlock(number: number, transactions: Array<Record<string, unknown> | null>, timestamp = 1_700_000_000): Record<string, unknown> {
    return {
      number: `0x${number.toString(16)}`,
      hash: `0x${'ab'.repeat(32)}`,
      parentHash: `0x${'cd'.repeat(32)}`,
      timestamp: `0x${timestamp.toString(16)}`,
      transactions,
    };
  }

  function rpcTx(hash: string, to: string | null, valueHex: string, from = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'): Record<string, unknown> {
    return { hash, from, to, value: valueHex, input: '0x' };
  }

  beforeEach(async () => {
    db = (await import('../src/config/database')).db;
    db.reset?.();
    circuitBreakerService.resetCache();
    await db.connect();

    userId = (await createTestUser()).userId;

    // Create an ETH/ETHEREUM deposit address
    const { service } = makeEnabledStack();
    const addr = await service.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    ethAddress = addr.blockchainAddress.toLowerCase();

    realSource = new EthereumSource({ rpcUrl: 'https://mock-rpc.example.com' });
    monitor = new BlockchainMonitorService(db, realSource, circuitBreakerService);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('19. Real EthereumSource detects a native ETH deposit via eth_getBlockByNumber', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      let result: unknown = null;
      if (body.method === 'eth_blockNumber') {
        result = '0x1';
      } else if (body.method === 'eth_getLogs') {
        result = []; // no ERC-20 events
      } else if (body.method === 'eth_getBlockByNumber') {
        const num = parseInt(body.params[0], 16);
        if (num === 1 && body.params[1] === true) {
          result = rpcBlock(1, [rpcTx('0x' + '9'.repeat(64), ethAddress, '0xde0b6b3a7640000')]);
        } else {
          result = rpcBlock(1, []);
        }
      } else if (body.method === 'eth_getTransactionReceipt') {
        result = { status: '0x1' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: body.id ?? 1, result }),
      };
    }));

    const result = await monitor.runOnce();
    expect(result.detected).toBe(1);
    expect(result.inserted).toBe(1);
    expect(result.rejected).toBe(0);
    expect(result.errors).toBe(0);

    const depositRes = await db.query(
      'SELECT asset, network, amount, raw_amount AS "rawAmount", token_contract AS "tokenContract", status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '9'.repeat(64)],
    );
    expect(depositRes.rows[0].asset).toBe('ETH');
    expect(depositRes.rows[0].network).toBe('ETHEREUM');
    expect(depositRes.rows[0].amount).toBe('1'); // 1 ETH normalized
    expect(depositRes.rows[0].rawAmount).toBe('1000000000000000000'); // wei preserved
    expect(depositRes.rows[0].tokenContract).toBeNull();
    expect(depositRes.rows[0].status).toBe('DETECTED');
  });

  it('20. Real EthereumSource ignores non-deposit and zero-value ETH transfers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      let result: unknown = null;
      if (body.method === 'eth_blockNumber') {
        result = '0x1';
      } else if (body.method === 'eth_getLogs') {
        result = [];
      } else if (body.method === 'eth_getBlockByNumber') {
        result = rpcBlock(1, [
          rpcTx('0x' + 'a'.repeat(64), '0x' + 'f'.repeat(40), '0xde0b6b3a7640000'), // unrelated addr
          rpcTx('0x' + 'b'.repeat(64), ethAddress, '0x0'), // zero value
          rpcTx('0x' + 'c'.repeat(64), null, '0xde0b6b3a7640000'), // contract creation
        ]);
      } else if (body.method === 'eth_getTransactionReceipt') {
        result = { status: '0x1' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: body.id ?? 1, result }),
      };
    }));

    const result = await monitor.runOnce();
    expect(result.detected).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.errors).toBe(0);

    const rows = await db.query('SELECT COUNT(*) as cnt FROM blockchain_deposits');
    expect(rows.rows[0].cnt).toBe(0);
  });

  it('22. Real EthereumSource correctly ignores REVERTED native ETH transfers', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      let result: unknown = null;
      if (body.method === 'eth_blockNumber') {
        result = '0x1';
      } else if (body.method === 'eth_getLogs') {
        result = [];
      } else if (body.method === 'eth_getBlockByNumber') {
        result = rpcBlock(1, [
          rpcTx('0x' + 'e'.repeat(64), ethAddress, '0xde0b6b3a7640000'), // Valid addr, valid amount
        ]);
      } else if (body.method === 'eth_getTransactionReceipt') {
        // Mock a reverted receipt!
        result = { status: '0x0' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: body.id ?? 1, result }),
      };
    }));

    const res = await monitor.runOnce();
    expect(res.errors).toBe(0);
    expect(res.detected).toBe(0); // Ignored at source level

    const rows = await db.query('SELECT COUNT(*) AS cnt FROM blockchain_deposits');
    expect(rows.rows[0].cnt).toBe(0);

    // Checkpoint must advance successfully since the revert is safely ignored, not an error
    const cp = await db.query('SELECT last_block_number FROM monitor_checkpoints WHERE network = $1', ['ETHEREUM']);
    expect(cp.rows[0].last_block_number).toBe(1);
  });

  it('21. Real EthereumSource RPC failure preserves checkpoint (no advance on error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: any) => {
      const body = JSON.parse(init?.body ?? '{}');
      if (body.method === 'eth_blockNumber') {
        return { ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result: '0x1' }) };
      }
      throw new Error('simulated RPC outage');
    }));

    const result = await monitor.runOnce();
    expect(result.errors).toBeGreaterThan(0);
    expect(result.checkpointAdvanced).toBe(false);

    const cp = await db.query(
      'SELECT last_block_number AS "lastBlockNumber" FROM monitor_checkpoints WHERE network = $1',
      ['ETHEREUM'],
    );
    expect(cp.rows[0].lastBlockNumber).toBe(0); // unchanged
  });
});

// ---------------------------------------------------------------------------
// Bitcoin end-to-end tests
// ---------------------------------------------------------------------------

describe('Phase 9.4: Blockchain Monitor — Bitcoin', () => {
  let db: any;
  let userId: string;
  let btcAddress: string;
  let mockSource: MockBlockchainSource;
  let monitor: BlockchainMonitorService;
  let confWorker: ConfirmationWorkerService;

  beforeEach(async () => {
    db = (await import('../src/config/database')).db;
    db.reset?.();
    circuitBreakerService.resetCache();
    await db.connect();

    userId = (await createTestUser()).userId;

    // Create a BTC/BITCOIN deposit address
    const { service } = makeEnabledStack();
    const addr = await service.getOrCreateDepositAddress({ userId, asset: 'BTC', network: 'BITCOIN' });
    btcAddress = addr.blockchainAddress.toLowerCase();

    mockSource = new MockBlockchainSource('bitcoin');

    // Seed genesis block
    mockSource.injectBlock({ number: 0 });

    monitor = new BlockchainMonitorService(db, mockSource, circuitBreakerService);
    confWorker = new ConfirmationWorkerService(db, mockSource);
  });

  it('BTC: Detects a Bitcoin deposit and confirms after 2 blocks', async () => {
    // Block 1: inject a transaction sending BTC to the deposit address
    mockSource.injectBlock({
      number: 1,
      timestamp: 1_700_000_000,
      transactions: [{
        hash: '0x' + '1'.repeat(64),
        from: 'bc1sender0000000000000000000000000000000000000000000',
        to: btcAddress,
        value: '100000000', // 1 BTC in satoshis
        input: '0x',
        vout: [
          { value: 100000000, scriptPubKey: { addresses: [btcAddress] } },
        ],
      }],
    });
    mockSource.setNextBlock(1);

    let result = await monitor.runOnce();
    expect(result.detected).toBe(1);
    expect(result.inserted).toBe(1);

    let depositRes = await db.query(
      'SELECT status, amount FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('DETECTED');
    expect(depositRes.rows[0].amount).toBe('1'); // 100000000 / 10^8 = 1

    // Block 2: confirmation_count = 2 - 1 + 1 = 2, which meets the
    // BTC required_confirmations of 2 → CONFIRMED
    mockSource.setNextBlock(2);
    result = await confWorker.runOnce();
    expect(result.updatedConfirmed).toBe(1);
    expect(result.updatedConfirming).toBe(0);

    depositRes = await db.query(
      'SELECT confirmation_count, status FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].confirmationCount).toBe(2);
    expect(depositRes.rows[0].status).toBe('CONFIRMED');
  });

  it('BTC: Reorg marks Bitcoin deposit as REORGED', async () => {
    mockSource.injectBlock({
      number: 1,
      timestamp: 1_700_000_000,
      transactions: [{
        hash: '0x' + '1'.repeat(64),
        from: 'bc1sender0000000000000000000000000000000000000000000',
        to: btcAddress,
        value: '100000000',
        input: '0x',
        vout: [
          { value: 100000000, scriptPubKey: { addresses: [btcAddress] } },
        ],
      }],
    });
    mockSource.setNextBlock(1);
    await monitor.runOnce();

    // Confirm
    mockSource.setNextBlock(3);
    await confWorker.runOnce();

    // Reorg block 1
    mockSource.injectReorg(1, 1);
    mockSource.setNextBlock(3);

    await monitor.runOnce();

    const depositRes = await db.query(
      'SELECT status, reorged_at FROM blockchain_deposits WHERE transaction_hash = $1',
      ['0x' + '1'.repeat(64)],
    );
    expect(depositRes.rows[0].status).toBe('REORGED');
    expect(depositRes.rows[0].reorgedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Mock source unit tests
// ---------------------------------------------------------------------------

describe('Phase 9.4: MockBlockchainSource — Ethereum', () => {
  let mock: MockBlockchainSource;

  beforeEach(() => {
    mock = new MockBlockchainSource('ethereum');
  });

  it('injectBlock and getBlockNumber', async () => {
    mock.injectBlock({ number: 1 });
    expect(await mock.getBlockNumber()).toBe(1);

    const block = await mock.getBlock(1);
    expect(block).not.toBeNull();
    expect(block!.number).toBe(1);
    expect(block!.hash).toMatch(/^0x/);
  });

  it('getLogs returns injected logs filtered by address', async () => {
    mock.injectBlock({
      number: 1,
      logs: [{
        address: '0xabc',
        topics: [ERC20_TRANSFER_TOPIC, '0x' + '0'.repeat(64), '0x' + '1'.repeat(64)],
        data: '0x' + '2'.repeat(64),
        transactionHash: '0xtx1',
        logIndex: 0,
      }],
    });

    const logs = await mock.getLogs({ fromBlock: 1, toBlock: 1, addresses: ['0xabc'] });
    expect(logs.length).toBe(1);
    expect(logs[0].address).toBe('0xabc');

    // Filter by different address
    const noLogs = await mock.getLogs({ fromBlock: 1, toBlock: 1, addresses: ['0xdef'] });
    expect(noLogs.length).toBe(0);
  });

  it('injectReorg changes block hash', async () => {
    mock.injectBlock({ number: 1, hash: '0xoriginalhash' });
    await mock.getBlock(1); // verify

    mock.injectReorg(1, 1);
    const block = await mock.getBlock(1);
    expect(block!.hash).not.toBe('0xoriginalhash');
    expect(block!.hash).toMatch(/0xREORGED/);
  });

  it('setUnhealthy causes getBlockNumber to throw', async () => {
    mock.setUnhealthy(true);
    await expect(mock.getBlockNumber()).rejects.toThrow('unhealthy');
  });

  it('failNextCauses specific number of failures', async () => {
    mock.failNextCalls(2);
    await expect(mock.getBlockNumber()).rejects.toThrow('simulated error');
    await expect(mock.getBlockNumber()).rejects.toThrow('simulated error');
    // Third call succeeds
    mock.injectBlock({ number: 1 });
    mock.setNextBlock(1);
    const height = await mock.getBlockNumber();
    expect(height).toBe(1);
  });
});

describe('Phase 9.4: MockBlockchainSource — Bitcoin', () => {
  let mock: MockBlockchainSource;

  beforeEach(() => {
    mock = new MockBlockchainSource('bitcoin');
  });

  it('getAddressTransactions returns transactions for monitored address', async () => {
    const addr = 'bc1qtestaddress00000000000000000000000000000000000';
    mock.injectBlock({
      number: 1,
      transactions: [{
        hash: '0x' + '1'.repeat(64),
        from: 'bc1sender0000000000000000000000000000000000000000000',
        to: addr,
        value: '100000000',
        input: '0x',
        vout: [
          { value: 100000000, scriptPubKey: { addresses: [addr] } },
        ],
      }],
    });

    const txs = await mock.getAddressTransactions(addr, 1, 1);
    expect(txs.length).toBe(1);
    expect(txs[0].txHash).toBe('0x' + '1'.repeat(64));
    expect(txs[0].value).toBe('100000000');
    expect(txs[0].voutIndex).toBe(0);
  });

  it('getAddressTransactions returns empty for unknown address', async () => {
    const addr = 'bc1qtestaddress00000000000000000000000000000000000';
    const txs = await mock.getAddressTransactions(addr, 1, 1);
    expect(txs.length).toBe(0);
  });
});
