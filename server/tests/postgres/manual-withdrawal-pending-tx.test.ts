/**
 * Phase 11K-B — F2: Pending Native ETH Transaction Must Not Be Accepted
 *
 * Infrastructure: LIVE disposable local Hardhat node (http://127.0.0.1:8545,
 * chainId 31337) + LIVE PostgreSQL.
 *
 * The ManualTxVerificationService must distinguish:
 *   PENDING / UNMINED  -> REJECTED (no receipt yet; not final execution evidence)
 *   MINED SUCCESS      -> accepted
 *   MINED FAILURE      -> rejected (reverted)
 *   NOT FOUND / UNKNOWN -> rejected
 *   WRONG CHAIN        -> rejected
 *
 * Critical invariant: ledger settlement MUST NEVER happen without a successful
 * mined receipt. A dropped/replaced pending tx must leave the withdrawal in a
 * recoverable state (READY_FOR_MANUAL_EXECUTION can be re-confirmed with the
 * replacement hash, or cancelled).
 *
 * This suite drives the REAL verification service against REAL on-chain
 * transactions (no mocks) and proves the end-to-end confirm state machine.
 *
 * NOTE: the env singleton and DB pool are imported DYNAMICALLY inside
 * beforeAll, AFTER the process.env values below are set — ESM static import
 * hoisting would otherwise evaluate config/env with the OLD environment.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { ethers, HDNodeWallet } from 'ethers';

const RPC_URL = 'http://127.0.0.1:8545';
const MNEMONIC = 'test test test test test test test test test test test junk';
const CHAIN_ID = 31337;

const account = (index: number) => ({
  wallet: HDNodeWallet.fromPhrase(MNEMONIC, '', `m/44'/60'/0'/0/${index}`),
});

// Use a fixed offset so the hot wallet account does not collide with the
// manual-verification.evm.test.ts suite (which uses accounts 0-5).
const HOT_ACCOUNT_INDEX = 6;

// MUST be set BEFORE any service module is imported (dynamic import below).
process.env.ETHEREUM_RPC_URL = RPC_URL;
process.env.CUSTODY_CHAIN_ID = '31337';
process.env.CUSTODY_HOT_WALLET_ADDRESS = account(HOT_ACCOUNT_INDEX).wallet.address;
process.env.NODE_ENV = 'test';
process.env.USE_REAL_PG = 'true';
process.env.CUSTODY_PROVIDER = 'manual_safe';

let db: any;
let provider: ethers.JsonRpcProvider;
let adminUserId: string;
let WithdrawalService: any;
let manualTxVerificationService: any;

const uniq = () => crypto.randomUUID().replace(/-/g, '').substring(0, 10);

/** A per-account broadcaster with explicit nonce (avoids ethers nonce cache). */
function makeBroadcaster(index: number) {
  let nextNonce: number | null = null;
  const { wallet } = account(index);
  return {
    address: wallet.address,
    async nonce(): Promise<number> {
      if (nextNonce === null) nextNonce = await provider.getTransactionCount(wallet.address, 'latest');
      return nextNonce!;
    },
    /** Sign + broadcast, auto-advancing the nonce counter. */
    async broadcast(tx: ethers.TransactionRequest, feeBump?: number): Promise<ethers.TransactionResponse> {
      const nonce = await this.nonce();
      nextNonce = nonce + 1;
      const signed = await wallet.signTransaction({
        ...tx,
        from: wallet.address,
        nonce,
        chainId: CHAIN_ID,
        type: 2,
        maxFeePerGas: ethers.parseUnits(String(feeBump ?? 10), 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits(String(feeBump ? Math.min(20, feeBump) : 1), 'gwei'),
      });
      return provider.broadcastTransaction(signed);
    },
    /** Sign + broadcast at an EXACT nonce (does NOT affect the tracked counter). */
    async broadcastAt(tx: ethers.TransactionRequest, nonce: number, feeBump?: number): Promise<ethers.TransactionResponse> {
      const signed = await wallet.signTransaction({
        ...tx,
        from: wallet.address,
        nonce,
        chainId: CHAIN_ID,
        type: 2,
        maxFeePerGas: ethers.parseUnits(String(feeBump ?? 12), 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits(String(feeBump ? Math.min(24, feeBump) : 1), 'gwei'),
      });
      return provider.broadcastTransaction(signed);
    },
    async sendAndMine(tx: ethers.TransactionRequest): Promise<ethers.TransactionReceipt | null> {
      const sent = await this.broadcast(tx);
      await provider.send('evm_mine', []);
      return provider.getTransactionReceipt(sent.hash);
    },
    async deploy(abi: any[], bytecode: string, gasLimit: bigint = 3_000_000n): Promise<ethers.Contract> {
      const factory = new ethers.ContractFactory(abi, bytecode, wallet);
      const deployTx = await factory.getDeployTransaction();
      const nonce = await this.nonce();
      nextNonce = nonce + 1;
      const signed = await wallet.signTransaction({
        ...deployTx,
        from: wallet.address,
        nonce,
        chainId: CHAIN_ID,
        type: 2,
        gasLimit,
        maxFeePerGas: ethers.parseUnits('10', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      });
      const sent = await provider.broadcastTransaction(signed);
      await provider.send('evm_mine', []);
      const receipt = await provider.getTransactionReceipt(sent.hash);
      if (!receipt || receipt.status !== 1) throw new Error('contract deployment failed');
      return new ethers.Contract(ethers.getCreateAddress({ from: wallet.address, nonce }), abi, wallet);
    },
  };
}

async function createUserWithFundingAccount(): Promise<{ userId: string; accountId: string }> {
  const userId = crypto.randomUUID();
  const email = `f2_${uniq()}@test.novacex.io`;
  await db.query(
    `INSERT INTO users (id, email, role, account_status, created_at, updated_at)
     VALUES ($1, $2, 'USER', 'ACTIVE', NOW(), NOW())`,
    [userId, email]
  );
  const accountId = crypto.randomUUID();
  await db.query(
    `INSERT INTO accounts (id, user_id, type, created_at, updated_at)
     VALUES ($1, $2, 'FUNDING', NOW(), NOW())`,
    [accountId, userId]
  );
  await db.query(
    `INSERT INTO asset_networks (asset, network, is_active, decimals, address_format, confirmations_required, min_withdrawal, withdrawal_fee)
     VALUES ('ETH', 'ETHEREUM', TRUE, 18, 'EVM_HEX', 12, '0', '0')
     ON CONFLICT (asset, network) DO NOTHING`
  );
  return { userId, accountId };
}

async function insertWithdrawal(
  accountId: string,
  destination: string,
  amount: string
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO withdrawals
       (id, account_id, asset, network, amount, fee, destination_address, status,
        crypto_status, created_at, updated_at)
     VALUES ($1, $2, 'ETH', 'ETHEREUM', $3, '0', $4, 'PENDING', 'READY_FOR_MANUAL_EXECUTION', NOW(), NOW())`,
    [id, accountId, amount, destination]
  );
  return id;
}

async function loadMockTokenArtifact(): Promise<any> {
  const artifact = await import(
    `../../../contracts/artifacts/contracts/MockToken.sol/MockToken.json`
  );
  return artifact?.default ?? artifact;
}

describe('Phase 11K-B — F2: Pending native ETH transaction is not accepted', () => {
  beforeAll(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    await provider.getBlockNumber();
    // Manual mining: disable automine so we can observe pending (unmined) txs.
    await provider.send('evm_setAutomine', [false]);

    // Dynamic imports AFTER process.env is set (ESM import hoisting).
    const dbMod = await import('../../src/config/database');
    const { PostgresDatabasePool } = dbMod;
    db = new PostgresDatabasePool();
    await db.connect();

    const verifierMod = await import('../../src/services/custody/manual-tx-verification.service');
    manualTxVerificationService = new verifierMod.ManualTxVerificationService();

    const wsvcMod = await import('../../src/services/wallet/withdrawal.service');
    WithdrawalService = wsvcMod.WithdrawalService;

    // Apply migration 035 + 036 so the schema and the F1 unique index exist.
    const mig035 = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/035_manual_safe_mode.sql'),
      'utf-8'
    ).replace(/^\uFEFF/, '');
    await db.query(mig035);
    const mig036 = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/036_manual_safe_unique_tx_hash.sql'),
      'utf-8'
    ).replace(/^\uFEFF/, '');
    await db.query(mig036);

    adminUserId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, role, account_status, created_at, updated_at)
       VALUES ($1, $2, 'ADMIN', 'ACTIVE', NOW(), NOW())`,
      [adminUserId, `admin_f2_${uniq()}@test.novacex.io`]
    );
  });

  afterAll(async () => {
    await db.close();
    // Flush any pending (unmined) txs left by the dropped/replaced scenarios so
    // a subsequent suite run on the same persistent node starts with a clean
    // mempool (mined txs also advance account nonces deterministically).
    try {
      for (let i = 0; i < 5; i++) await provider.send('evm_mine', []);
    } catch { /* ignore */ }
    // Restore automine for any subsequent suite on the same node.
    try { await provider.send('evm_setAutomine', [true]); } catch { /* ignore */ }
  });

  it('A. PENDING (in mempool, no receipt) — verification rejected, withdrawal stays READY', async () => {
    const b = makeBroadcaster(7);
    const recipient = ethers.getAddress('0x' + '22'.repeat(20));

    // Broadcast WITHOUT mining -> transaction is in the mempool, no receipt.
    const sent = await b.broadcast({ to: recipient, value: ethers.parseEther('0.5'), gasLimit: 21000 });
    expect(await provider.getTransactionReceipt(sent.hash)).toBeNull(); // no receipt yet

    // Direct verification: pending tx must be REJECTED (not accepted).
    const res = await manualTxVerificationService.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: sent.hash,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'ETH',
      expectedAmount: '0.5',
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/pending|not yet mined/i);

    // End-to-end: confirmManualWithdrawal with a pending hash must throw and
    // leave the withdrawal in READY_FOR_MANUAL_EXECUTION (NO premature SUBMITTED,
    // NO settlement).
    const { accountId } = await createUserWithFundingAccount();
    const wid = await insertWithdrawal(accountId, recipient, '0.5');
    const service = new WithdrawalService(db);
    await expect(
      service.confirmManualWithdrawal(wid, sent.hash, adminUserId)
    ).rejects.toThrow(/On-chain verification failed/i);

    const row = await db.query(`SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wid]);
    expect(row.rows[0].crypto_status).toBe('READY_FOR_MANUAL_EXECUTION');
    expect(row.rows[0].tx_hash).toBeNull();
  });

  it('B. MINED SUCCESS — verification accepted, withdrawal -> SUBMITTED', async () => {
    // The sender MUST be the hot wallet (confirmManualWithdrawal verifies the
    // on-chain sender against CUSTODY_HOT_WALLET_ADDRESS).
    const b = makeBroadcaster(HOT_ACCOUNT_INDEX);
    const recipient = ethers.getAddress('0x' + '33'.repeat(20));

    const receipt = await b.sendAndMine({ to: recipient, value: ethers.parseEther('0.5'), gasLimit: 21000 });
    expect(receipt!.status).toBe(1);

    const res = await manualTxVerificationService.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: receipt!.hash!,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'ETH',
      expectedAmount: '0.5',
    });
    expect(res.verified).toBe(true);

    const { accountId } = await createUserWithFundingAccount();
    const wid = await insertWithdrawal(accountId, recipient, '0.5');
    const service = new WithdrawalService(db);
    await service.confirmManualWithdrawal(wid, receipt!.hash!, adminUserId);

    const row = await db.query(`SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wid]);
    expect(row.rows[0].crypto_status).toBe('SUBMITTED');
    expect(row.rows[0].tx_hash).toBe(receipt!.hash!);
  });

  it('C. MINED FAILURE (reverted) — verification rejected', async () => {
    const b = makeBroadcaster(8);
    // Deploy a contract without receive() so a plain ETH send reverts.
    const artifact = await loadMockTokenArtifact();
    const abi = artifact?.abi ?? artifact?.default?.abi;
    const bytecode = artifact?.bytecode ?? artifact?.default?.bytecode;
    const token = await b.deploy(abi, bytecode);
    const tokenAddress = await token.getAddress();

    const sent = await b.broadcast({ to: tokenAddress, value: ethers.parseEther('0.001'), gasLimit: 30000 });
    await provider.send('evm_mine', []);
    const reverted = await provider.getTransactionReceipt(sent.hash);
    expect(reverted!.status).toBe(0);

    const res = await manualTxVerificationService.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: reverted!.hash!,
      expectedSender: b.address,
      expectedDestination: tokenAddress,
      asset: 'ETH',
      expectedAmount: '0.001',
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/reverted/i);
  });

  it('D. NOT FOUND — verification rejected', async () => {
    const res = await manualTxVerificationService.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: '0x' + crypto.randomBytes(32).toString('hex'),
      expectedSender: account(0).wallet.address,
      expectedDestination: '0x' + '44'.repeat(20),
      asset: 'ETH',
      expectedAmount: '0.1',
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/not found/i);
  });

  it('E. DROPPED / REPLACED pending tx — recovery path (re-confirm with replacement hash)', async () => {
    // Sender MUST be the hot wallet (confirmManualWithdrawal verifies sender).
    const b = makeBroadcaster(HOT_ACCOUNT_INDEX);
    const recipient = ethers.getAddress('0x' + '55'.repeat(20));

    // Broadcast a pending tx (in mempool, never mined -> "dropped").
    const dropped = await b.broadcast({ to: recipient, value: ethers.parseEther('0.5'), gasLimit: 21000 });
    expect(await provider.getTransactionReceipt(dropped.hash)).toBeNull();

    const { accountId } = await createUserWithFundingAccount();
    const wid = await insertWithdrawal(accountId, recipient, '0.5');
    const service = new WithdrawalService(db);

    // Confirm with the dropped hash -> rejected, stays READY (recoverable).
    await expect(
      service.confirmManualWithdrawal(wid, dropped.hash, adminUserId)
    ).rejects.toThrow(/On-chain verification failed/i);
    let row = await db.query(`SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wid]);
    expect(row.rows[0].crypto_status).toBe('READY_FOR_MANUAL_EXECUTION');

    // Recovery: operator REPLACES the pending tx at the SAME nonce with a
    // higher fee. The original is dropped from the mempool; the replacement
    // is mined (status 1).
    const droppedNonce = await provider.getTransactionCount(b.address, 'latest');
    const replacement = await b.broadcastAt(
      { to: recipient, value: ethers.parseEther('0.5'), gasLimit: 21000 },
      droppedNonce,
      20 // higher maxFeePerGas -> replaces the pending tx at the same nonce
    );
    await provider.send('evm_mine', []);
    const replacementReceipt = await provider.getTransactionReceipt(replacement.hash);
    expect(replacementReceipt!.status).toBe(1);
    // The dropped hash must NOT have been mined (it was replaced).
    expect(await provider.getTransactionReceipt(dropped.hash)).toBeNull();

    // The SAME withdrawal is now confirmed with the replacement hash.
    await service.confirmManualWithdrawal(wid, replacement.hash, adminUserId);
    row = await db.query(`SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wid]);
    expect(row.rows[0].crypto_status).toBe('SUBMITTED');
    expect(row.rows[0].tx_hash).toBe(replacement.hash);
  });

  it('F. mined on WRONG CHAIN — verification rejected (cross-chain replay)', async () => {
    const b = makeBroadcaster(9);
    const recipient = ethers.getAddress('0x' + '66'.repeat(20));
    const receipt = await b.sendAndMine({ to: recipient, value: ethers.parseEther('0.01'), gasLimit: 21000 });

    // Expected mainnet chainId=1 while the local node reports 31337.
    const res = await manualTxVerificationService.verifyTreasuryTx(
      {
        network: 'ETHEREUM',
        txHash: receipt!.hash!,
        expectedSender: b.address,
        expectedDestination: recipient,
        asset: 'ETH',
        expectedAmount: '0.01',
      },
      1
    );
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/chainId mismatch/i);
  });
});