import { test, expect, beforeAll, afterAll } from 'vitest';
import { ethers } from 'ethers';
import Ganache from 'ganache';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

process.env.USE_REAL_PG = 'true';
process.env.NODE_ENV = 'staging';
process.env.CUSTODY_ENABLED = 'true';
process.env.CUSTODY_PROVIDER = 'manual_safe';
process.env.TESTNET_RPC_URL = 'http://127.0.0.1:8546'; // In case it's missing in env.ts

let db: any;
let safeVerificationService: any;
let withdrawalService: any;
let custodyService: any;
let treasuryManagerService: any;
let treasuryMonitorService: any;
let SchemaMigrator: any;

// Setup Ganache mimicking Sepolia
const ganacheOptions = {
    chain: {
        chainId: 11155111,
        networkId: 11155111,
    },
    logging: { quiet: true }
};

let server: any;
let provider: ethers.JsonRpcProvider;
let testnetOwner: ethers.Wallet;
let testnetHotWallet: ethers.Wallet;
let mockSafeAddress: string;

const scratchDir = 'C:\\Users\\saif mallick\\.gemini\\antigravity\\brain\\8a00636f-caf8-4387-8b91-c40a066b9bfe\\scratch';

let globalUserId: string;
let adminUserId: string;

beforeAll(async () => {
    // ... inside beforeAll
    server = Ganache.server(ganacheOptions);
    await new Promise<void>((resolve, reject) => {
        server.listen(8546, (err: any) => {
            if (err) return reject(err);
            resolve();
        });
    });

    provider = new ethers.JsonRpcProvider('http://127.0.0.1:8546');
    const accounts = await provider.listAccounts();
    const signer1 = await provider.getSigner(accounts[0].address);
    const signer2 = await provider.getSigner(accounts[1].address);

    // Testnet Owner (MetaMask)
    testnetOwner = new ethers.Wallet("0x" + "1".repeat(64), provider);
    // Hot Wallet (Sender)
    testnetHotWallet = new ethers.Wallet("0x" + "2".repeat(64), provider);

    // Fund them
    await signer1.sendTransaction({ to: testnetOwner.address, value: ethers.parseEther("10") });
    await signer1.sendTransaction({ to: testnetHotWallet.address, value: ethers.parseEther("10") });

    // Deploy MockSafe
    const abiName = '__________gemini_antigravity_brain_8a00636f-caf8-4387-8b91-c40a066b9bfe_scratch_MockSafe_sol_MockSafe.abi';
    const binName = '__________gemini_antigravity_brain_8a00636f-caf8-4387-8b91-c40a066b9bfe_scratch_MockSafe_sol_MockSafe.bin';
    const abi = fs.readFileSync(path.join(scratchDir, abiName), 'utf8');
    const bin = fs.readFileSync(path.join(scratchDir, binName), 'utf8');
    const factory = new ethers.ContractFactory(abi, bin, testnetOwner);
    const safeContract = await factory.deploy(testnetOwner.address);
    await safeContract.waitForDeployment();
    mockSafeAddress = await safeContract.target as string;

    // Set process.env
    process.env.NODE_ENV = 'staging';
    process.env.CUSTODY_PROVIDER = 'manual_safe';
    process.env.CUSTODY_ENABLED = 'true';
    process.env.CUSTODY_HOT_WALLET_ADDRESS = testnetHotWallet.address;
    process.env.CUSTODY_CHAIN_ID = '11155111';
    process.env.TREASURY_SAFE_ADDRESS = mockSafeAddress;
    process.env.TREASURY_SAFE_OWNER_ADDRESS = testnetOwner.address;
    process.env.TREASURY_SAFE_CHAIN_ID = '11155111';
    process.env.ETHEREUM_RPC_URL = 'http://127.0.0.1:8546';
    process.env.HYPERLIQUID_ENV = 'testnet';

    // OVERRIDE ENV
    const envModule = await import('../../src/config/env');
    envModule.env.CUSTODY_ENABLED = true;
    envModule.env.CUSTODY_PROVIDER = 'manual_safe';

    // Also re-instantiate custodyService to ensure it picks up the override
    const custodyModule = await import('../../src/services/custody/custody.service');
    const { ManualSafeCustodyProvider } = await import('../../src/services/custody/manual-safe-custody-provider');
    db = (await import('../../src/config/database')).db;
    const adapter = new ManualSafeCustodyProvider(db);
    (custodyModule.custodyService as any).enabled = true;
    (custodyModule.custodyService as any).adapter = adapter;

    safeVerificationService = (await import('../../src/services/treasury/safe-verification.service')).safeVerificationService;
    withdrawalService = (await import('../../src/services/wallet/withdrawal.service')).withdrawalService;
    custodyService = custodyModule.custodyService;
    treasuryManagerService = (await import('../../src/services/treasury/treasury-manager.service')).treasuryManagerService;
    const { TreasuryMonitorService } = await import('../../src/services/treasury/treasury-monitor.service');
    const { treasuryService } = await import('../../src/services/treasury/treasury.service');
    treasuryMonitorService = new TreasuryMonitorService(treasuryService, safeVerificationService, 'ETHEREUM');
    SchemaMigrator = (await import('../../src/config/migrator')).SchemaMigrator;

    // DB setup
    await db.connect();
    await new SchemaMigrator(undefined, db).runMigrations();

    // Truncate some tables to avoid conflicts
    await db.query(`TRUNCATE TABLE withdrawals CASCADE`);
    await db.query(`TRUNCATE TABLE treasury_transactions CASCADE`);
    await db.query(`TRUNCATE TABLE wallet_balances CASCADE`);
    await db.query(`TRUNCATE TABLE accounts CASCADE`);
    await db.query(`TRUNCATE TABLE users CASCADE`);

    // Create users if not exist
    globalUserId = crypto.randomUUID();
    adminUserId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    await db.query(`INSERT INTO users (id, email) VALUES ('${globalUserId}', '${globalUserId}@test.com')`);
    await db.query(`INSERT INTO users (id, email) VALUES ('${adminUserId}', '${adminUserId}@test.com')`);
    await db.query(`INSERT INTO accounts (id, user_id, type) VALUES ('${accountId}', '${globalUserId}', 'FUNDING')`);
    await db.query(`INSERT INTO wallet_balances (account_id, asset, available_balance, locked_balance) VALUES ('${accountId}', 'ETH', '10.0', '0.0')`);
    await db.query(`INSERT INTO user_kyc_profiles (user_id, status, tier) VALUES ('${globalUserId}', 'VERIFIED', 'TIER_1')`);
});

afterAll(async () => {
    await db.close();
    await server.close();
});

test('Step 2, 9, 10: Run SafeVerificationService against Sepolia Safe', async () => {
    // Will internally use process.env.TREASURY_SAFE_ADDRESS, etc.
    const result = await safeVerificationService.verifySafeOnChain(mockSafeAddress, testnetOwner.address, 1, 11155111, 'http://127.0.0.1:8546');
    expect(result).toBe(true);
});

test('Step 11, 12: Manual Customer Withdrawal Test', async () => {
    // 1. Customer initiates
    const withdrawal = await withdrawalService.cryptoWithdraw({ userId: globalUserId, asset: 'ETH', network: 'ETHEREUM', amount: '0.1', destinationAddress: testnetOwner.address });
    const wId = withdrawal.id;

    // 2. Admin approves
    await withdrawalService.approveWithdrawalAdmin(wId, adminUserId);

    // Simulate WithdrawalProcessingWorker
    await withdrawalService.claimApprovedWithdrawals(20);
    // manual_safe provider returns READY_FOR_MANUAL_EXECUTION
    await withdrawalService.markReadyForManualExecution(wId);

    let row = await db.query(`SELECT crypto_status FROM withdrawals WHERE id = $1`, [wId]);
    expect(row.rows[0].crypto_status).toBe('READY_FOR_MANUAL_EXECUTION');

    // 3. Human sends from TESTNET HOT WALLET
    const tx = await testnetHotWallet.sendTransaction({
        to: testnetOwner.address,
        value: ethers.parseEther("0.1")
    });
    // STEP 12: Test pending transaction
    // Note: Ganache mines instantly by default, but let's just record it.

    // 4. Backend records tx_hash
    await withdrawalService.confirmManualWithdrawal(wId, tx.hash, adminUserId);

    // 5. Backend verifies tx -> SUBMITTED (manual_safe mode leaves it at SUBMITTED until monitor runs)
    row = await db.query(`SELECT status, crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wId]);
    expect(row.rows[0].crypto_status).toBe('SUBMITTED');
    expect(row.rows[0].tx_hash).toBe(tx.hash);
});

test('Step 13: Test Cancellation', async () => {
    const withdrawal = await withdrawalService.cryptoWithdraw({ userId: globalUserId, asset: 'ETH', network: 'ETHEREUM', amount: '0.1', destinationAddress: testnetOwner.address });
    const wId = withdrawal.id;
    await withdrawalService.approveWithdrawalAdmin(wId, adminUserId);

    // Simulate WithdrawalProcessingWorker
    await withdrawalService.claimApprovedWithdrawals(20);
    // manual_safe provider returns READY_FOR_MANUAL_EXECUTION
    await withdrawalService.markReadyForManualExecution(wId);

    // Cancel before sending
    await withdrawalService.cancelWithdrawal(wId);

    const row = await db.query(`SELECT status FROM withdrawals WHERE id = $1`, [wId]);
    expect(row.rows[0].status).toBe('REJECTED');
});

test('Step 14 & 15: Manual Treasury Test & Reconciliation', async () => {
    // 1. Create treasury intent with signature
    const intentId = crypto.randomUUID();

    const currentNonceRow = await db.query(`SELECT admin_nonce FROM treasury_config WHERE network = 'ETHEREUM'`);
    const nonce = currentNonceRow.rows.length > 0 ? Number(currentNonceRow.rows[0].admin_nonce) : 0;

    const expiry = Math.floor(Date.now() / 1000) + 3600;

    const domain = {
        name: 'NovaCEX Treasury',
        version: '1',
        chainId: 11155111,
        verifyingContract: mockSafeAddress
    };

    const types = {
        Consolidate: [
            { name: 'network', type: 'string' },
            { name: 'asset', type: 'string' },
            { name: 'amount', type: 'string' },
            { name: 'destination', type: 'address' },
            { name: 'intentId', type: 'string' },
            { name: 'nonce', type: 'uint256' },
            { name: 'expiry', type: 'uint256' }
        ]
    };

    const value = {
        network: 'ETHEREUM',
        asset: 'ETH',
        amount: '0.05',
        destination: mockSafeAddress,
        intentId,
        nonce,
        expiry
    };

    const signature = await testnetOwner.signTypedData(domain, types, value);

    const withdrawalRequest = await treasuryManagerService.consolidateToSafe(
        'ETHEREUM',
        'ETH',
        '0.05',
        adminUserId,
        signature,
        nonce,
        expiry,
        intentId
    );

    const intentRow = await db.query(`SELECT status FROM treasury_transactions WHERE client_withdrawal_id = $1`, [`treasury-ETHEREUM-ETH-${intentId}`]);
    expect(intentRow.rows[0].status).toBe('READY_FOR_MANUAL_EXECUTION');

    // 2. Human sends tx
    const tx = await testnetHotWallet.sendTransaction({
        to: mockSafeAddress,
        value: ethers.parseEther("0.05")
    });
    await tx.wait();

    // 3. Submit tx hash
    await treasuryManagerService.confirmManualTreasuryTransfer(`treasury-ETHEREUM-ETH-${intentId}`, tx.hash, adminUserId);
    const row2 = await db.query(`SELECT status FROM treasury_transactions WHERE client_withdrawal_id = $1`, [`treasury-ETHEREUM-ETH-${intentId}`]);
    expect(row2.rows[0].status).toBe('CONFIRMED');

    // Verify exactly one row exists for this transfer
    const allRows = await db.query(`SELECT * FROM treasury_transactions WHERE tx_hash = $1`, [tx.hash]);
    expect(allRows.rows.length).toBe(1);
    expect(allRows.rows[0].status).toBe('CONFIRMED');
});
