/**
 * Phase 15D-1: Deposit Identity Routing Remediation Test Suite
 *
 * Validates the fix for CRIT-01:
 * Decoupling Cryptographic Identity (blockchain_address + network -> userId)
 * from Asset Identity (token contract address / native transfer -> asset_networks).
 *
 * Test Matrix:
 * Scenario A: User has only ETH deposit address + USDC sent to address -> accepted & credited
 * Scenario B: User has only ETH deposit address + USDT sent to address -> accepted & credited
 * Scenario C: Supported token (USDC) sent to unknown address -> rejected (UNKNOWN_DEPOSIT_ADDRESS)
 * Scenario D: Unsupported token contract sent to known address -> rejected (UNSUPPORTED_ASSET_NETWORK)
 * Scenario E: Supported token on wrong network -> rejected (UNSUPPORTED_ASSET_NETWORK)
 * Scenario F: Duplicate event -> exactly once credit
 * Scenario G: Same tx with multiple ERC20 transfers (different logIndex) -> each handled independently
 * Scenario H: Native ETH sent to forwarder address generated for USDT -> accepted & credited
 * Scenario I: ERC20 and ETH share the same forwarder -> both credited to same user's FUNDING account
 * Scenario J: Customer isolation & Ambiguous address rejection
 * Scenario K: Precision audit verification (no float distortion)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ethers } from 'ethers';
import Decimal from 'decimal.js';
import { db } from '../src/config/database';
import { env } from '../src/config/env';
import { authService } from '../src/services/auth/auth.service';
import {
  createCustodyService,
  createDepositAddressService,
} from '../src/services/custody';
import { ManualSafeCustodyProvider } from '../src/services/custody/manual-safe-custody-provider';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { BlockchainMonitorService } from '../src/services/blockchain/blockchain-monitor.service';
import { ConfirmationWorkerService } from '../src/services/blockchain/confirmation-worker.service';
import { DepositCreditingService } from '../src/services/blockchain/deposit-crediting.service';
import { MockBlockchainSource } from '../src/services/blockchain/sources/mock-source';
import { ERC20_TRANSFER_TOPIC } from '../src/services/blockchain/types';

// Approved asset contract addresses on Ethereum
const USDT_CONTRACT = '0xdAC17F958D2ee523a2206206994597C13D831ec7';
const USDC_CONTRACT = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const UNKNOWN_CONTRACT = '0x000000000000000000000000000000000000dead';

// Custody Factory & Implementation mock constants
const mockFactoryAddress = '0x1111111111111111111111111111111111111111';
const mockImplementationAddress = '0x2222222222222222222222222222222222222222';
const mockExpectedInitCode = ethers.solidityPacked(
  ['bytes', 'bytes20', 'bytes'],
  ['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', mockImplementationAddress, '0x5af43d82803e903d91602b57fd5bf3']
);
const mockInitCodeHash = ethers.keccak256(mockExpectedInitCode);

function padToTopic(addr: string): string {
  const clean = addr.replace(/^0x/, '').toLowerCase();
  return '0x' + clean.padStart(64, '0');
}

function encodeUint256(value: string | bigint): string {
  const big = typeof value === 'string' ? BigInt(value) : value;
  return '0x' + big.toString(16).padStart(64, '0');
}

async function createTestUser(): Promise<{ userId: string; email: string }> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const signup = await authService.signup({
    email: `identity_${unique}@novacex.io`,
    password: 'TestPassword123!Secure',
    username: `iduser_${unique}`,
  });
  return { userId: signup.user.id, email: signup.user.email };
}

describe('CRIT-01: Deposit Identity Routing & ERC20 Matrix', () => {
  let mockSource: MockBlockchainSource;
  let monitor: BlockchainMonitorService;
  let confWorker: ConfirmationWorkerService;
  let creditingService: DepositCreditingService;
  let addressService: any;
  let manualSafe: ManualSafeCustodyProvider;

  beforeEach(async () => {
    (db as any).reset?.();
    circuitBreakerService.resetCache();
    await db.connect();

    env.CUSTODY_FACTORY_ADDRESS = mockFactoryAddress;
    env.CUSTODY_IMPLEMENTATION_ADDRESS = mockImplementationAddress;
    env.CUSTODY_INIT_CODE_HASH = mockInitCodeHash;
    env.CUSTODY_ENABLED = true;
    env.CUSTODY_PROVIDER = 'manual_safe';
    env.DEPOSIT_CREDITING_ENABLED = true;

    manualSafe = new ManualSafeCustodyProvider(db);
    vi.spyOn(manualSafe, 'getSupportedAssetNetworks').mockResolvedValue([
      { asset: 'ETH', network: 'ETHEREUM', isActive: true, requiresMemo: false, addressFormat: 'EVM_HEX' },
      { asset: 'USDT', network: 'ETHEREUM', isActive: true, requiresMemo: false, addressFormat: 'EVM_HEX' },
      { asset: 'USDC', network: 'ETHEREUM', isActive: true, requiresMemo: false, addressFormat: 'EVM_HEX' },
    ]);

    const custody = createCustodyService({ enabled: true, adapter: manualSafe });
    addressService = createDepositAddressService({ custody });

    mockSource = new MockBlockchainSource('ethereum');
    mockSource.injectBlock({ number: 0 });
    mockSource.setNextBlock(0);

    monitor = new BlockchainMonitorService(db, mockSource, circuitBreakerService);
    confWorker = new ConfirmationWorkerService(db, mockSource);
    creditingService = new DepositCreditingService(db);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Scenario A: User has only ETH deposit address + USDC sent to same address
  // ==========================================================================
  it('Scenario A: User has only ETH deposit address + USDC sent to address -> accepted and credited', async () => {
    const { userId } = await createTestUser();

    // 1. Generate ONLY ETH address record
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    // Verify deposit_addresses table has ONLY 1 record for this user (ETH)
    const existingAddrs = await db.query(
      `SELECT asset, network, blockchain_address FROM deposit_addresses WHERE user_id = $1`,
      [userId]
    );
    expect(existingAddrs.rows.length).toBe(1);
    expect(existingAddrs.rows[0].asset).toBe('ETH');

    // 2. Incoming transfer: 100 USDC (6 decimals: 100,000,000) sent to the forwarder address
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDC_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
          padToTopic(forwarderAddress),
        ],
        data: encodeUint256('100000000'), // 100 USDC
        transactionHash: '0x' + 'a'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    // 3. Monitor runs
    const monitorRes = await monitor.runOnce();
    expect(monitorRes.detected).toBe(1);
    expect(monitorRes.inserted).toBe(1);
    expect(monitorRes.rejected).toBe(0);

    // Verify row in blockchain_deposits: correctly attributed to USDC despite only ETH record in deposit_addresses
    const depRes = await db.query<any>(
      `SELECT id, asset, network, amount, raw_amount, status, to_address FROM blockchain_deposits WHERE transaction_hash = $1`,
      ['0x' + 'a'.repeat(64)]
    );
    expect(depRes.rows.length).toBe(1);
    expect(depRes.rows[0].asset).toBe('USDC');
    expect(depRes.rows[0].network).toBe('ETHEREUM');
    expect(depRes.rows[0].amount).toBe('100');
    expect(depRes.rows[0].raw_amount).toBe('100000000');
    expect(depRes.rows[0].status).toBe('DETECTED');

    // 4. Advance block height to 15 (>= 12 required confirmations)
    mockSource.setNextBlock(15);
    await confWorker.runOnce();

    const confRes = await db.query<any>(
      `SELECT status, confirmation_count FROM blockchain_deposits WHERE transaction_hash = $1`,
      ['0x' + 'a'.repeat(64)]
    );
    expect(confRes.rows[0].status).toBe('CONFIRMED');
    expect(confRes.rows[0].confirmation_count).toBeGreaterThanOrEqual(12);

    // 5. Crediting worker credits user's FUNDING account
    await creditingService.processBacklog(50);

    const fundingAcc = await db.query<any>(
      `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
      [userId]
    );
    const balanceRes = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDC']
    );
    expect(balanceRes.rows.length).toBe(1);
    expect(new Decimal(balanceRes.rows[0].available_balance).eq('100')).toBe(true);
  });

  // ==========================================================================
  // Scenario B: User has only ETH deposit address + USDT sent to same address
  // ==========================================================================
  it('Scenario B: User has only ETH deposit address + USDT sent to address -> accepted and credited', async () => {
    const { userId } = await createTestUser();

    // 1. Generate ONLY ETH address record
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    // 2. Incoming transfer: 50 USDT (6 decimals: 50,000,000)
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDT_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'),
          padToTopic(forwarderAddress),
        ],
        data: encodeUint256('50000000'), // 50 USDT
        transactionHash: '0x' + 'b'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    // 3. Monitor runs
    const monitorRes = await monitor.runOnce();
    expect(monitorRes.detected).toBe(1);
    expect(monitorRes.inserted).toBe(1);

    // 4. Confirm and credit
    mockSource.setNextBlock(15);
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const fundingAcc = await db.query<any>(
      `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
      [userId]
    );
    const balanceRes = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDT']
    );
    expect(balanceRes.rows.length).toBe(1);
    expect(new Decimal(balanceRes.rows[0].available_balance).eq('50')).toBe(true);
  });

  // ==========================================================================
  // Scenario C: Supported token sent to unknown address
  // ==========================================================================
  it('Scenario C: Supported token (USDC) sent to unknown address -> rejected (UNKNOWN_DEPOSIT_ADDRESS)', async () => {
    // Seed at least one known user address so the monitor scans Ethereum
    const { userId } = await createTestUser();
    await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });

    const unknownAddress = '0x9999999999999999999999999999999999999999';

    // Mock an event for an unknown destination address and validate directly
    const event: any = {
      chainId: 'ethereum',
      network: 'ETHEREUM',
      asset: 'USDC',
      transactionHash: '0x' + 'c'.repeat(64),
      blockNumber: 1,
      blockHash: '0xhash',
      blockTimestamp: new Date(),
      logIndex: 0,
      fromAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
      toAddress: unknownAddress,
      amount: '100',
      rawAmount: '100000000',
      tokenContract: USDC_CONTRACT,
      decimals: 6,
      requiredConfirmations: 12,
    };

    const valRes = await (monitor as any).validateEvent(event);
    expect(valRes.valid).toBe(false);
    expect(valRes.status).toBe('REJECTED');
    expect(valRes.rejection.reason).toBe('UNKNOWN_DEPOSIT_ADDRESS');
  });

  // ==========================================================================
  // Scenario D: Unsupported token contract sent to known user address
  // ==========================================================================
  it('Scenario D: Unsupported token contract sent to known user address -> rejected (UNSUPPORTED_ASSET_NETWORK)', async () => {
    const { userId } = await createTestUser();
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    const event: any = {
      chainId: 'ethereum',
      network: 'ETHEREUM',
      asset: '',
      transactionHash: '0x' + 'd'.repeat(64),
      blockNumber: 1,
      blockHash: '0xhash',
      blockTimestamp: new Date(),
      logIndex: 0,
      fromAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
      toAddress: forwarderAddress,
      amount: '100',
      rawAmount: '100000000',
      tokenContract: UNKNOWN_CONTRACT,
      decimals: 0,
      requiredConfirmations: 0,
    };

    const valRes = await (monitor as any).validateEvent(event);
    expect(valRes.valid).toBe(false);
    expect(valRes.status).toBe('REJECTED');
    expect(valRes.rejection.reason).toBe('UNSUPPORTED_ASSET_NETWORK');
  });

  // ==========================================================================
  // Scenario E: Supported token on wrong network
  // ==========================================================================
  it('Scenario E: Supported token on wrong network -> rejected (UNSUPPORTED_ASSET_NETWORK)', async () => {
    // Sepolia monitor validating an event with a Mainnet-only token contract
    const sepoliaSource = new MockBlockchainSource('ethereum');
    const sepoliaMonitor = new BlockchainMonitorService(db, sepoliaSource, circuitBreakerService);
    (sepoliaMonitor as any).network = 'ETHEREUM_SEPOLIA';

    const event: any = {
      chainId: 'ethereum_sepolia',
      network: 'ETHEREUM_SEPOLIA',
      asset: 'USDC',
      transactionHash: '0x' + 'e'.repeat(64),
      blockNumber: 1,
      blockHash: '0xhash',
      blockTimestamp: new Date(),
      logIndex: 0,
      fromAddress: '0xfrom',
      toAddress: '0xto',
      amount: '100',
      rawAmount: '100000000',
      tokenContract: USDC_CONTRACT, // USDC contract exists on ETHEREUM, not on ETHEREUM_SEPOLIA
      decimals: 6,
      requiredConfirmations: 12,
    };

    const valResult = await (sepoliaMonitor as any).validateEvent(event);
    expect(valResult.valid).toBe(false);
    expect(valResult.status).toBe('REJECTED');
    expect(valResult.rejection.reason).toBe('UNSUPPORTED_ASSET_NETWORK');
  });

  // ==========================================================================
  // Scenario F: Duplicate event -> exactly once credit
  // ==========================================================================
  it('Scenario F: Duplicate event -> exactly once credit', async () => {
    const { userId } = await createTestUser();
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDC_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0xffffffffffffffffffffffffffffffffffffffff'),
          padToTopic(forwarderAddress),
        ],
        data: encodeUint256('100000000'), // 100 USDC
        transactionHash: '0x' + 'f'.repeat(64),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(1);

    // Initial scan
    await monitor.runOnce();
    mockSource.setNextBlock(15);
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const fundingAcc = await db.query<any>(
      `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
      [userId]
    );
    const balRes1 = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDC']
    );
    expect(new Decimal(balRes1.rows[0].available_balance).eq('100')).toBe(true);

    // Simulate re-scan: rewind checkpoint and re-run monitor
    await db.query(`UPDATE monitor_checkpoints SET last_block_number = 0 WHERE network = 'ETHEREUM'`);
    const rescanResult = await monitor.runOnce();
    expect(rescanResult.inserted).toBe(0); // ON CONFLICT DO NOTHING

    // Re-run crediting
    await creditingService.processBacklog(50);

    const balRes2 = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDC']
    );
    // Balance strictly unchanged: exactly 100
    expect(new Decimal(balRes2.rows[0].available_balance).eq('100')).toBe(true);
  });

  // ==========================================================================
  // Scenario G: Same transaction with multiple ERC-20 transfers (different logIndex)
  // ==========================================================================
  it('Scenario G: Same transaction with multiple ERC20 transfers -> each handled independently', async () => {
    const { userId } = await createTestUser();
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    const sharedTxHash = '0x' + '7'.repeat(64);

    mockSource.injectBlock({
      number: 1,
      logs: [
        {
          address: USDC_CONTRACT,
          topics: [
            ERC20_TRANSFER_TOPIC,
            padToTopic('0x7171717171717171717171717171717171717171'),
            padToTopic(forwarderAddress),
          ],
          data: encodeUint256('40000000'), // 40 USDC
          transactionHash: sharedTxHash,
          logIndex: 0,
        },
        {
          address: USDT_CONTRACT,
          topics: [
            ERC20_TRANSFER_TOPIC,
            padToTopic('0x7272727272727272727272727272727272727272'),
            padToTopic(forwarderAddress),
          ],
          data: encodeUint256('60000000'), // 60 USDT
          transactionHash: sharedTxHash,
          logIndex: 1,
        },
      ],
    });
    mockSource.setNextBlock(1);

    const monitorRes = await monitor.runOnce();
    expect(monitorRes.detected).toBe(2);
    expect(monitorRes.inserted).toBe(2);

    mockSource.setNextBlock(15);
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const fundingAcc = await db.query<any>(
      `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
      [userId]
    );

    const usdcBal = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDC']
    );
    const usdtBal = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDT']
    );

    expect(new Decimal(usdcBal.rows[0].available_balance).eq('40')).toBe(true);
    expect(new Decimal(usdtBal.rows[0].available_balance).eq('60')).toBe(true);
  });

  // ==========================================================================
  // Scenario H: Native ETH sent to forwarder address generated for a token (e.g. USDT)
  // ==========================================================================
  it('Scenario H: Native ETH sent to forwarder address generated for USDT -> accepted and credited', async () => {
    const { userId } = await createTestUser();

    // 1. User generated address ONLY for USDT (no ETH row in deposit_addresses)
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'USDT', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    const existingAddrs = await db.query(
      `SELECT asset, network FROM deposit_addresses WHERE user_id = $1`,
      [userId]
    );
    expect(existingAddrs.rows.length).toBe(1);
    expect(existingAddrs.rows[0].asset).toBe('USDT');

    // 2. Send 1.5 ETH (18 decimals: 1,500,000,000,000,000,000 wei)
    const rawWei = '1500000000000000000';
    mockSource.injectBlock({
      number: 1,
      transactions: [{
        hash: '0x' + '8'.repeat(64),
        from: '0x8888888888888888888888888888888888888888',
        to: forwarderAddress,
        value: rawWei,
        input: '0x',
      }],
    });
    mockSource.setNextBlock(1);

    // 3. Monitor runs — getActiveDepositAddresses scans all addresses regardless of asset
    const monitorRes = await monitor.runOnce();
    expect(monitorRes.detected).toBe(1);
    expect(monitorRes.inserted).toBe(1);

    const depRes = await db.query<any>(
      `SELECT asset, network, amount, raw_amount FROM blockchain_deposits WHERE transaction_hash = $1`,
      ['0x' + '8'.repeat(64)]
    );
    expect(depRes.rows[0].asset).toBe('ETH');
    expect(depRes.rows[0].amount).toBe('1.5');
    expect(depRes.rows[0].raw_amount).toBe(rawWei);

    // 4. Confirm and credit
    mockSource.setNextBlock(15);
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const fundingAcc = await db.query<any>(
      `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
      [userId]
    );
    const ethBal = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'ETH']
    );
    expect(new Decimal(ethBal.rows[0].available_balance).eq('1.5')).toBe(true);
  });

  // ==========================================================================
  // Scenario I: ERC20 and ETH share the same forwarder -> both credited to same user
  // ==========================================================================
  it('Scenario I: ERC20 and ETH share the same forwarder -> both attributed to same user FUNDING account', async () => {
    const { userId } = await createTestUser();
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    // Block 1: Native ETH deposit of 2.0 ETH
    mockSource.injectBlock({
      number: 1,
      transactions: [{
        hash: '0x' + '91'.repeat(32),
        from: '0x9191919191919191919191919191919191919191',
        to: forwarderAddress,
        value: '2000000000000000000', // 2 ETH
        input: '0x',
      }],
    });

    // Block 2: ERC-20 deposit of 250 USDC
    mockSource.injectBlock({
      number: 2,
      logs: [{
        address: USDC_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x9292929292929292929292929292929292929292'),
          padToTopic(forwarderAddress),
        ],
        data: encodeUint256('250000000'), // 250 USDC
        transactionHash: '0x' + '92'.repeat(32),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(2);

    await monitor.runOnce();

    mockSource.setNextBlock(16);
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const fundingAcc = await db.query<any>(
      `SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`,
      [userId]
    );

    const ethBal = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'ETH']
    );
    const usdcBal = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [fundingAcc.rows[0].id, 'USDC']
    );

    expect(new Decimal(ethBal.rows[0].available_balance).eq('2')).toBe(true);
    expect(new Decimal(usdcBal.rows[0].available_balance).eq('250')).toBe(true);
  });

  // ==========================================================================
  // Scenario J: Customer Isolation & Ambiguous Address Rejection
  // ==========================================================================
  it('Scenario J: Customer isolation preserved; conflicting multi-user ownership rejected', async () => {
    const user1 = await createTestUser();
    const user2 = await createTestUser();

    const addrRecord1 = await addressService.getOrCreateDepositAddress({ userId: user1.userId, asset: 'ETH', network: 'ETHEREUM' });
    const addrRecord2 = await addressService.getOrCreateDepositAddress({ userId: user2.userId, asset: 'ETH', network: 'ETHEREUM' });

    // Addresses must be strictly different
    expect(addrRecord1.blockchainAddress.toLowerCase()).not.toBe(addrRecord2.blockchainAddress.toLowerCase());

    // Deposit to User 1's forwarder
    mockSource.injectBlock({
      number: 1,
      logs: [{
        address: USDC_CONTRACT,
        topics: [
          ERC20_TRANSFER_TOPIC,
          padToTopic('0x1010101010101010101010101010101010101010'),
          padToTopic(addrRecord1.blockchainAddress),
        ],
        data: encodeUint256('500000000'), // 500 USDC
        transactionHash: '0x' + '10'.repeat(32),
        logIndex: 0,
      }],
    });
    mockSource.setNextBlock(15);

    await monitor.runOnce();
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const funding1 = await db.query<any>(`SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`, [user1.userId]);
    const funding2 = await db.query<any>(`SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`, [user2.userId]);

    const bal1 = await db.query<any>(`SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`, [funding1.rows[0].id, 'USDC']);
    const bal2 = await db.query<any>(`SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`, [funding2.rows[0].id, 'USDC']);

    expect(new Decimal(bal1.rows[0].available_balance).eq('500')).toBe(true);
    expect(bal2.rows.length).toBe(0); // User 2 received nothing

    // Now test Ambiguous Address ownership assertion:
    // If database somehow has two rows with the same address for DIFFERENT users:
    const user3 = await createTestUser();
    const user4 = await createTestUser();
    const collisionAddr = '0xcccccccccccccccccccccccccccccccccccccccc';
    await db.query(
      `INSERT INTO deposit_addresses (id, user_id, asset, network, provider_id, custody_account_id, provider_address_id, blockchain_address, memo, status, address_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      ['da-col-1', user3.userId, 'ETH', 'ETHEREUM', 'prov-1', null, 'paddr-col-1', collisionAddr, null, 'ACTIVE', null]
    );
    await db.query(
      `INSERT INTO deposit_addresses (id, user_id, asset, network, provider_id, custody_account_id, provider_address_id, blockchain_address, memo, status, address_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      ['da-col-2', user4.userId, 'USDC', 'ETHEREUM', 'prov-2', null, 'paddr-col-2', collisionAddr, null, 'ACTIVE', null]
    );

    const ambEvent: any = {
      chainId: 'ethereum',
      network: 'ETHEREUM',
      asset: 'USDC',
      transactionHash: '0x' + '99'.repeat(32),
      blockNumber: 2,
      blockHash: '0xbl',
      blockTimestamp: new Date(),
      logIndex: 0,
      fromAddress: '0xfrom',
      toAddress: collisionAddr,
      amount: '100',
      rawAmount: '100000000',
      tokenContract: USDC_CONTRACT,
      decimals: 6,
      requiredConfirmations: 12,
    };

    const ambVal = await (monitor as any).validateEvent(ambEvent);
    expect(ambVal.valid).toBe(false);
    expect(ambVal.status).toBe('REJECTED');
    expect(ambVal.rejection.reason).toBe('AMBIGUOUS_DEPOSIT_ADDRESS');

    // Also verify processDepositSafely catches ambiguous ownership and leaves deposit uncredited
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      ['dep-amb', 'ethereum', 'USDC', 'ETHEREUM', '0xambhash', 100, '0xbl', new Date(), 0, '0xfrom', collisionAddr, '100', '100000000', USDC_CONTRACT, 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );
    await (creditingService as any).processDepositSafely('dep-amb');
    const depCheck = await db.query<any>(`SELECT is_credited FROM blockchain_deposits WHERE id = $1`, ['dep-amb']);
    expect(depCheck.rows[0].is_credited).toBe(false);
  });

  // ==========================================================================
  // Scenario K: Precision verification (no float rounding or distortion)
  // ==========================================================================
  it('Scenario K: Precision verification — micro-unit amounts maintain exact precision', async () => {
    const { userId } = await createTestUser();
    const addrRecord = await addressService.getOrCreateDepositAddress({ userId, asset: 'ETH', network: 'ETHEREUM' });
    const forwarderAddress = addrRecord.blockchainAddress.toLowerCase();

    // Smallest possible wei unit: 1 wei
    mockSource.injectBlock({
      number: 1,
      transactions: [{
        hash: '0x' + '55'.repeat(32),
        from: '0x5555555555555555555555555555555555555555',
        to: forwarderAddress,
        value: '1', // 1 wei = 0.000000000000000001 ETH
        input: '0x',
      }],
    });
    mockSource.setNextBlock(1);

    await monitor.runOnce();

    const depRes = await db.query<any>(
      `SELECT amount, raw_amount FROM blockchain_deposits WHERE transaction_hash = $1`,
      ['0x' + '55'.repeat(32)]
    );
    expect(depRes.rows[0].raw_amount).toBe('1');
    expect(depRes.rows[0].amount).toBe('0.000000000000000001');

    mockSource.setNextBlock(15);
    await confWorker.runOnce();
    await creditingService.processBacklog(50);

    const funding = await db.query<any>(`SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`, [userId]);
    const balRes = await db.query<any>(
      `SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2`,
      [funding.rows[0].id, 'ETH']
    );
    expect(new Decimal(balRes.rows[0].available_balance).eq('0.000000000000000001')).toBe(true);
  });
});
