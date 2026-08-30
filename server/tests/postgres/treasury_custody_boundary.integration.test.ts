/**
 * Phase 10.4 (unfreeze) — CUSTODY/KMS CROSS-BOUNDARY: HOUSE TREASURY
 *
 * Proves the dedicated treasury custody boundary against the restored
 * Phase 10.4 KMS stack:
 *   A. treasury vs customer isolation (CAL-level, both directions)
 *   B. treasury correlation (intent → artifact → physical tx hash)
 *   C. crash-after-broadcast recovery (ONE intent = ONE tx = ONE row)
 *   D. duplicate treasury submission (idempotent, no second tx, one nonce)
 *   E. KMS nonce sharing (treasury + customer share hot_wallet_nonces safely)
 *   F/G. signed-artifact + broadcast recovery (exact-byte rebroadcast)
 *   H. confirmation (receipt probe → CONFIRMED)
 *   I. reorg (treasury monitor marks REORGED — reuse, no duplicated logic)
 *   J. customer withdrawal non-regression on the same provider
 *
 * Infrastructure classification:
 *   - PostgreSQL : LIVE (disposable local container, real migrations 001-030)
 *   - EVM        : LIVE local Hardhat node (ephemeral)
 *   - Contracts  : REAL MockSafe.sol deployed locally (test-only Safe stand-in)
 *   - KMS        : LocalKmsMock (local software signer; dedicated key — NOT
 *                  Hardhat account #0)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { ethers, HDNodeWallet } from 'ethers';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { KmsCustodyProvider } from '../../src/services/custody/kms-custody-provider';
import { LocalKmsMock } from '../../src/services/custody/local-kms-mock';
import { MockCustodyProvider } from '../../src/services/custody/mock-custody-provider';
import { CustodyService } from '../../src/services/custody/custody.service';
import { HOUSE_TREASURY_ACCOUNT_ID } from '../../src/services/custody/custody.types';
import { TreasuryManagerService } from '../../src/services/treasury/treasury-manager.service';
import { TreasuryService } from '../../src/services/treasury/treasury.service';
import { SafeVerificationService } from '../../src/services/treasury/safe-verification.service';
import { TreasuryMonitorService } from '../../src/services/treasury/treasury-monitor.service';

const RPC_URL = 'http://127.0.0.1:8545';
const MNEMONIC = 'test test test test test test test test test test test junk';
/** Hardhat account #7 — dedicated deployer/funder for this file. */
// ethers v6 signature: fromPhrase(phrase, password, path) — password must be
// EMPTY (standard Hardhat accounts use no BIP39 passphrase); passing the path
// as the password would derive a wallet OUTSIDE the pre-funded node accounts.
const HARDHAT_KEY7 = HDNodeWallet.fromPhrase(MNEMONIC, '', "m/44'/60'/0'/0/7").privateKey;
/** Hardhat account #9 — plays the independent MetaMask Safe owner. */
const METAMASK_OWNER_ADDRESS = HDNodeWallet.fromPhrase(MNEMONIC, '', "m/44'/60'/0'/0/9").address;
/** Dedicated hot-wallet mock key — NOT Hardhat account #0, not used by other files. */
const HOT_MOCK_KEY = '0x' + '77'.repeat(32);
const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const uniq = () => crypto.randomUUID().replace(/-/g, '').substring(0, 12);

let db: PostgresDatabasePool;
let jsonRpc: ethers.JsonRpcProvider;
let deployer: ethers.Wallet;
let provider: KmsCustodyProvider;
let custodySvc: CustodyService;
let manager: TreasuryManagerService;
let monitor: TreasuryMonitorService;
let safeAddress: string;
let hotWallet: string;
let available = false;
let skipReason = 'ENVIRONMENT BLOCKED: local Hardhat node not running (npx hardhat node)';

let fundingChain: Promise<any> = Promise.resolve();
let fundingNonce: number | null = null;

function sendFunded(to: string, valueEth: string): Promise<ethers.TransactionReceipt | null> {
  fundingChain = fundingChain.then(async () => {
    if (fundingNonce === null) fundingNonce = await jsonRpc.getTransactionCount(deployer.address, 'latest');
    const tx = await deployer.sendTransaction({ to, value: ethers.parseEther(valueEth), nonce: fundingNonce! });
    fundingNonce!++;
    return await tx.wait();
  });
  return fundingChain;
}

async function insertTreasuryIntent(intentId: string, amount: string): Promise<void> {
  await db.query(
    `INSERT INTO treasury_transactions
       (network, chain_id, asset, token_contract, source_address, destination_address, amount,
        tx_hash, log_index, block_number, block_hash, status, client_withdrawal_id)
     VALUES ('ETHEREUM','31337','ETH',NULL,'KMS_HOT_WALLET',$1,$2::numeric,NULL,0,0,'PENDING','PENDING',$3)`,
    [safeAddress, amount, intentId]
  );
}

async function backdateIntent(intentId: string, minutes: number): Promise<void> {
  await db.query(
    `UPDATE treasury_transactions SET created_at = NOW() - ($1 || ' minutes')::interval WHERE client_withdrawal_id = $2`,
    [String(minutes), intentId]
  );
}

describe.sequential('Phase 10.4 (unfreeze) — Treasury custody boundary', () => {
  beforeAll(async () => {
    // Probe EVM availability first (ENVIRONMENT BLOCKED contract).
    try {
      const probe = new ethers.JsonRpcProvider(RPC_URL);
      await probe.getBlockNumber();
      available = true;
    } catch {
      available = false;
    }
    if (!available) {
      console.warn(skipReason);
      return;
    }

    // Trusted Safe anchor config (read at CALL time by manager/monitor — not module load).
    process.env.TREASURY_SAFE_ADDRESS_ETHEREUM = '';
    process.env.TREASURY_SAFE_OWNER_ADDRESS_ETHEREUM = '';
    process.env.TREASURY_SAFE_CHAIN_ID_ETHEREUM = '31337';
    process.env.ETHEREUM_RPC_URL = RPC_URL;

    db = new PostgresDatabasePool();
    await db.connect();
    await new SchemaMigrator(undefined, db).runMigrations();

    await db.query(`INSERT INTO assets (symbol, name, decimals, is_active, is_fiat) VALUES ('ETH','Ethereum',18,TRUE,FALSE) ON CONFLICT (symbol) DO NOTHING`);
    await db.query(`INSERT INTO asset_networks (asset, network, contract_address, decimals, is_active, confirmations_required) VALUES ('ETH','ETHEREUM',NULL,18,TRUE,12) ON CONFLICT (asset,network) DO NOTHING`);

    jsonRpc = new ethers.JsonRpcProvider(RPC_URL);
    deployer = new ethers.Wallet(HARDHAT_KEY7!, jsonRpc);

    // Deploy the test-only Safe stand-in (owner = the independent MetaMask owner).
    const safeArtifact = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '../../../contracts/artifacts/contracts/MockSafe.sol/MockSafe.json'), 'utf8'));
    const safeFactory = new ethers.ContractFactory(safeArtifact.abi, safeArtifact.bytecode, deployer);
    const safe = await safeFactory.deploy(METAMASK_OWNER_ADDRESS);
    await safe.waitForDeployment();
    safeAddress = await safe.getAddress();

    process.env.TREASURY_SAFE_ADDRESS_ETHEREUM = safeAddress;
    process.env.TREASURY_SAFE_OWNER_ADDRESS_ETHEREUM = METAMASK_OWNER_ADDRESS;

    // KMS provider on a dedicated hot wallet; fund it for real transfers.
    const kms = new LocalKmsMock(HOT_MOCK_KEY);
    provider = new KmsCustodyProvider(
      kms,
      { ETHEREUM: { rpcUrl: RPC_URL, keyId: 'mock-key-treasury', chainId: 31337n } } as any,
      db
    );
    hotWallet = await provider.getHotWalletAddress('ETHEREUM');
    await sendFunded(hotWallet, '10');

    custodySvc = new CustodyService({ enabled: true, adapter: provider });
    manager = new TreasuryManagerService(custodySvc, new TreasuryService(db), new SafeVerificationService());
    monitor = new TreasuryMonitorService(new TreasuryService(db), new SafeVerificationService(), 'ETHEREUM');

    // Treasury config row (monitor readiness check) + clean nonce domain for the hot wallet.
    await db.query(
      `INSERT INTO treasury_config (network, chain_id, safe_address, owner_address, threshold, low_water_usd, high_water_usd)
       VALUES ('ETHEREUM','31337',$1,$2,1,0,0) ON CONFLICT (network) DO NOTHING`,
      [safeAddress, METAMASK_OWNER_ADDRESS]
    );
    await db.query(`DELETE FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`, [hotWallet]);
  }, 120000);

  afterAll(async () => {
    if (db) await db.close();
  });

  // =========================================================================
  // A. Treasury vs customer isolation (CAL-level, both directions)
  // =========================================================================
  it('A1. LIVE CAL: customer requestWithdrawal REJECTS the HOUSE_TREASURY principal', async () => {
    const mock = new MockCustodyProvider({
      supportedAssetNetworks: [{
        asset: 'ETH', network: 'ETHEREUM', isActive: true, decimals: 18, confirmationsRequired: 12,
        minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', contractAddress: null,
        addressFormat: 'EVM_HEX', requiresMemo: false,
      }],
    } as any);
    const svc = new CustodyService({ enabled: true, adapter: mock });

    await expect(svc.requestWithdrawal({
      clientWithdrawalId: crypto.randomUUID(),
      accountId: HOUSE_TREASURY_ACCOUNT_ID,
      asset: 'ETH', network: 'ETHEREUM', amount: '1',
      destinationAddress: ethers.Wallet.createRandom().address,
      status: 'PENDING', createdAt: new Date(), updatedAt: new Date(),
    })).rejects.toThrow(/HOUSE_TREASURY/);
  });

  it('A2. LIVE CAL: customer requestWithdrawal still accepts a real account principal (no over-rejection)', async () => {
    const mock = new MockCustodyProvider({
      supportedAssetNetworks: [{
        asset: 'ETH', network: 'ETHEREUM', isActive: true, decimals: 18, confirmationsRequired: 12,
        minDeposit: '0', minWithdrawal: '0', withdrawalFee: '0', contractAddress: null,
        addressFormat: 'EVM_HEX', requiresMemo: false,
      }],
    } as any);
    const svc = new CustodyService({ enabled: true, adapter: mock });
    const accountId = crypto.randomUUID();
    const result = await svc.requestWithdrawal({
      clientWithdrawalId: crypto.randomUUID(),
      accountId,
      asset: 'ETH', network: 'ETHEREUM', amount: '1',
      destinationAddress: ethers.Wallet.createRandom().address,
      status: 'PENDING', createdAt: new Date(), updatedAt: new Date(),
    });
    expect(result.accountId).toBe(accountId);
  });

  it('A3. LIVE CAL: treasury operation rejects malformed destinations and zero amounts (fail closed)', async () => {
    await expect(custodySvc.submitTreasuryTransfer({
      treasuryIntentId: 'treasury-bad-' + uniq(),
      asset: 'ETH', network: 'ETHEREUM', amount: '0', destinationAddress: safeAddress,
    })).rejects.toThrow(/positive/i);
    await expect(custodySvc.submitTreasuryTransfer({
      treasuryIntentId: 'treasury-bad-' + uniq(),
      asset: 'ETH', network: 'ETHEREUM', amount: '1', destinationAddress: 'not-an-address',
    })).rejects.toThrow(/EVM address/i);
  });

  it('A4. LIVE CAL: disabled custody fails closed for BOTH operations', async () => {
    const disabled = new CustodyService({ enabled: false, adapter: null });
    await expect(disabled.submitTreasuryTransfer({
      treasuryIntentId: 'treasury-x-' + uniq(), asset: 'ETH', network: 'ETHEREUM',
      amount: '1', destinationAddress: safeAddress,
    })).rejects.toThrow();
    await expect(disabled.requestWithdrawal({
      clientWithdrawalId: crypto.randomUUID(), accountId: crypto.randomUUID(),
      asset: 'ETH', network: 'ETHEREUM', amount: '1',
      destinationAddress: ethers.Wallet.createRandom().address,
      status: 'PENDING', createdAt: new Date(), updatedAt: new Date(),
    })).rejects.toThrow();
  });

  // =========================================================================
  // B + H. Correlation & confirmation through the REAL KMS provider
  // =========================================================================
  it('B/H. LIVE EVM+PG: submitTreasuryTransfer correlates intent → artifact → REAL tx hash; status confirms', async () => {
    const intentId = `treasury-ETHEREUM-ETH-${crypto.randomUUID()}`;
    await insertTreasuryIntent(intentId, '0.5');

    const result = await custodySvc.submitTreasuryTransfer({
      treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
      amount: '0.5', destinationAddress: safeAddress,
    });

    // Physical tx identity: providerReference IS an actual blockchain hash.
    expect(result.providerReference).toMatch(TX_HASH_RE);
    expect(result.status).toBe('BROADCAST');

    // Artifact correlation: exactly one artifact keyed by the immutable intent id.
    const art = await db.query(
      `SELECT network_nonce, tx_hash, raw_signed_tx, status FROM treasury_custody_artifacts WHERE treasury_intent_id = $1`,
      [intentId]
    );
    expect(art.rowCount).toBe(1);
    expect(art.rows[0].tx_hash).toBe(result.providerReference);
    expect(art.rows[0].raw_signed_tx).toMatch(/^0x[0-9a-fA-F]+$/);
    expect(art.rows[0].status).toBe('BROADCAST');

    // The physical hash is a REAL mined transaction to the Safe.
    const receipt = await jsonRpc.getTransactionReceipt(result.providerReference!);
    expect(receipt).not.toBeNull();
    expect(receipt!.to.toLowerCase()).toBe(safeAddress.toLowerCase());
    expect(receipt!.status).toBe(1);
    const tx = await jsonRpc.getTransaction(result.providerReference!);
    expect(BigInt(tx!.value)).toBe(BigInt(ethers.parseEther('0.5')));

    // Confirmation probe.
    const status = await custodySvc.getTreasuryTransferStatus(intentId);
    expect(status.status).toBe('CONFIRMED');
    expect(status.providerReference).toBe(result.providerReference);

    // DB-level tx-hash identity: garbage is rejected by the CHECK itself.
    await expect(db.query(
      `UPDATE treasury_transactions SET tx_hash = 'mock-wd-not-a-hash' WHERE client_withdrawal_id = $1`,
      [intentId]
    )).rejects.toThrow();

    // The intent→tx_hash correlation is the manager's job and is proven in C1;
    // here we prove the ARTIFACT (the custody-side durable record) already
    // carries the physical identity.
    const art2 = await db.query(
      `SELECT tx_hash, status FROM treasury_custody_artifacts WHERE treasury_intent_id = $1`,
      [intentId]
    );
    expect(art2.rows[0].tx_hash).toBe(result.providerReference);
    expect(art2.rows[0].status).toBe('BROADCAST');
  });

  // =========================================================================
  // C. Crash window: broadcast happened, intent row still tx_hash = NULL
  // =========================================================================
  it('C1. LIVE EVM+PG: crash-after-broadcast — recoverPendingIntents restores the REAL tx hash, exactly ONE row', async () => {
    const intentId = `treasury-ETHEREUM-ETH-${crypto.randomUUID()}`;
    await insertTreasuryIntent(intentId, '0.25');

    // Custody executes, but the (simulated) process dies BEFORE the manager
    // correlates: intent row stays PENDING with tx_hash = NULL.
    const result = await custodySvc.submitTreasuryTransfer({
      treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
      amount: '0.25', destinationAddress: safeAddress,
    });
    expect(result.providerReference).toMatch(TX_HASH_RE);
    await db.query(
      `UPDATE treasury_transactions SET status='PENDING', tx_hash=NULL, updated_at=NOW() WHERE client_withdrawal_id=$1`,
      [intentId]
    );
    await backdateIntent(intentId, 10);

    await manager.recoverPendingIntents();

    const rows = await db.query(
      `SELECT tx_hash, status FROM treasury_transactions WHERE client_withdrawal_id = $1`,
      [intentId]
    );
    expect(rows.rowCount).toBe(1); // ONE logical intent = ONE treasury record
    expect(rows.rows[0].tx_hash).toBe(result.providerReference); // physical identity restored
    expect(['BROADCAST', 'CONFIRMED']).toContain(rows.rows[0].status);
  });

  it('C2. LIVE EVM+PG: monitor-race merge — unlinked physical row is ADOPTED, no duplicate row', async () => {
    const intentId = `treasury-ETHEREUM-ETH-${crypto.randomUUID()}`;
    await insertTreasuryIntent(intentId, '0.125');
    const result = await custodySvc.submitTreasuryTransfer({
      treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
      amount: '0.125', destinationAddress: safeAddress,
    });
    // Simulate the monitor having discovered the physical tx independently.
    await db.query(
      `INSERT INTO treasury_transactions
         (network, chain_id, asset, token_contract, source_address, destination_address, amount,
          tx_hash, log_index, block_number, block_hash, status, client_withdrawal_id)
       VALUES ('ETHEREUM','31337','ETH',NULL,$1,$2,'125000000000000000'::numeric,$3,0,1,'0x' || $4,'CONFIRMED',NULL)`,
      [hotWallet.toLowerCase(), safeAddress.toLowerCase(), result.providerReference, 'ab'.repeat(32)]
    );
    await db.query(
      `UPDATE treasury_transactions SET status='PENDING', tx_hash=NULL, updated_at=NOW() WHERE client_withdrawal_id=$1`,
      [intentId]
    );
    await backdateIntent(intentId, 10);

    await manager.recoverPendingIntents();

    // The intent row was merged INTO the physical row and the original deleted.
    const byIntent = await db.query(
      `SELECT id, tx_hash, status FROM treasury_transactions WHERE client_withdrawal_id = $1`,
      [intentId]
    );
    expect(byIntent.rowCount).toBe(1);
    expect(byIntent.rows[0].tx_hash).toBe(result.providerReference);
    const totalForIntentOrHash = await db.query(
      `SELECT COUNT(*)::int AS n FROM treasury_transactions WHERE client_withdrawal_id = $1 OR tx_hash = $2`,
      [intentId, result.providerReference]
    );
    expect(Number(totalForIntentOrHash.rows[0].n)).toBe(1); // NO duplicate row
  });

  // =========================================================================
  // D + E. Duplicate submission idempotency + shared nonce domain
  // =========================================================================
  it('D/E. LIVE EVM+PG: duplicate submission is idempotent; treasury + customer share ONE nonce domain', async () => {
    const intentId = `treasury-ETHEREUM-ETH-${crypto.randomUUID()}`;
    await insertTreasuryIntent(intentId, '0.0625');

    const nonceBefore = await db.query(
      `SELECT next_nonce FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`,
      [hotWallet]
    );
    const beforeVal = nonceBefore.rowCount > 0 ? parseInt(nonceBefore.rows[0].next_nonce, 10) : null;

    const r1 = await custodySvc.submitTreasuryTransfer({
      treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
      amount: '0.0625', destinationAddress: safeAddress,
    });
    const r2 = await custodySvc.submitTreasuryTransfer({
      treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
      amount: '0.0625', destinationAddress: safeAddress,
    });

    expect(r2.providerReference).toBe(r1.providerReference); // same physical tx
    const arts = await db.query(
      `SELECT COUNT(*)::int AS n FROM treasury_custody_artifacts WHERE treasury_intent_id = $1`,
      [intentId]
    );
    expect(Number(arts.rows[0].n)).toBe(1); // ONE artifact

    const nonceAfter = await db.query(
      `SELECT next_nonce FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`,
      [hotWallet]
    );
    const afterVal = parseInt(nonceAfter.rows[0].next_nonce, 10);
    const expectedAfter = (beforeVal ?? 0) + 1; // exactly ONE nonce consumed total
    if (beforeVal === null) {
      // first ever reservation seeds from chain; +1 from this transfer
      expect(afterVal).toBeGreaterThanOrEqual(1);
    } else {
      expect(afterVal).toBe(expectedAfter);
    }

    // Second intent consumes exactly one more nonce — no collision, no reuse.
    const intent2 = `treasury-ETHEREUM-ETH-${crypto.randomUUID()}`;
    await insertTreasuryIntent(intent2, '0.03125');
    const r3 = await custodySvc.submitTreasuryTransfer({
      treasuryIntentId: intent2, asset: 'ETH', network: 'ETHEREUM',
      amount: '0.03125', destinationAddress: safeAddress,
    });
    expect(r3.providerReference).toMatch(TX_HASH_RE);
    expect(r3.providerReference).not.toBe(r1.providerReference);
    const nonceFinal = await db.query(
      `SELECT next_nonce FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`,
      [hotWallet]
    );
    expect(parseInt(nonceFinal.rows[0].next_nonce, 10)).toBe(afterVal + 1);
  });

  // =========================================================================
  // F/G. Signed-artifact + broadcast recovery (exact-byte rebroadcast)
  // =========================================================================
  it('F/G. LIVE EVM+PG: artifact SIGNED but broadcast unknown → resubmission rebroadcasts EXACT bytes, no second tx', async () => {
    const intentId = `treasury-ETHEREUM-ETH-${crypto.randomUUID()}`;
    await insertTreasuryIntent(intentId, '0.015625');

    // Stop automatic mining: broadcast lands in the PENDING mempool — the real
    // "broadcast outcome unknown" precondition. evm_setAutomine(false) fully
    // disables mining (no interval); blocks advance only via explicit evm_mine.
    await jsonRpc.send('evm_setAutomine', [false]);
    try {
      const r1 = await custodySvc.submitTreasuryTransfer({
        treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
        amount: '0.015625', destinationAddress: safeAddress,
      });
      expect(r1.status).toBe('BROADCAST');

      // Confirm the physical tx is genuinely PENDING (not mined).
      const r1Receipt = await jsonRpc.getTransactionReceipt(r1.providerReference!);
      expect(r1Receipt).toBeNull();

      // Simulate the crash window: the artifact survives with exact bytes but
      // the process never learned the broadcast outcome (status stays SIGNED).
      const artBefore = await db.query(
        `SELECT id FROM treasury_custody_artifacts WHERE treasury_intent_id = $1`,
        [intentId]
      );
      await db.query(
        `UPDATE treasury_custody_artifacts SET status='SIGNED', updated_at=NOW() WHERE id=$1`,
        [artBefore.rows[0].id]
      );

      // Resubmission: probes the chain, finds the tx PENDING, returns the SAME
      // physical tx without signing again (no second nonce, no second tx).
      const r2 = await custodySvc.submitTreasuryTransfer({
        treasuryIntentId: intentId, asset: 'ETH', network: 'ETHEREUM',
        amount: '0.015625', destinationAddress: safeAddress,
      });
      expect(r2.providerReference).toBe(r1.providerReference); // EXACT same physical tx
      expect(r2.status).toBe('BROADCAST');

      const arts = await db.query(
        `SELECT COUNT(*)::int AS n FROM treasury_custody_artifacts WHERE treasury_intent_id = $1`,
        [intentId]
      );
      expect(Number(arts.rows[0].n)).toBe(1);

      // Mine the pending tx; the SAME intent confirms through the same artifact.
      await jsonRpc.send('evm_mine', []);
      const status = await custodySvc.getTreasuryTransferStatus(intentId);
      expect(status.status).toBe('CONFIRMED');
      expect(status.providerReference).toBe(r1.providerReference);
    } finally {
      await jsonRpc.send('evm_setAutomine', [true]);
    }
  });

  // =========================================================================
  // J. Customer withdrawal non-regression on the SAME provider
  // =========================================================================
  it('J. LIVE EVM+PG: customer withdrawal still works after treasury ops — nonce continuity, no cross-domain artifacts', async () => {
    const userId = crypto.randomUUID();
    await db.query(`INSERT INTO users (id, email) VALUES ($1,$2)`, [userId, `tbnd_${uniq()}@test.novacex.io`]);
    const accountId = crypto.randomUUID();
    await db.query(`INSERT INTO accounts (id, user_id, type) VALUES ($1,$2,'FUNDING')`, [accountId, userId]);
    const withdrawalId = crypto.randomUUID();
    await db.query(
      `INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, status, crypto_status, destination_address, created_at, updated_at)
       VALUES ($1,$2,'ETH','ETHEREUM','0.5','0','PENDING','APPROVED',$3,NOW(),NOW())`,
      [withdrawalId, accountId, ethers.Wallet.createRandom().address]
    );

    const result = await custodySvc.requestWithdrawal({
      clientWithdrawalId: withdrawalId,
      accountId,
      asset: 'ETH', network: 'ETHEREUM', amount: '0.5',
      destinationAddress: (await db.query(`SELECT destination_address FROM withdrawals WHERE id=$1`, [withdrawalId])).rows[0].destination_address,
      status: 'PENDING', createdAt: new Date(), updatedAt: new Date(),
    });
    expect(result.status).toBe('BROADCAST');
    expect(result.providerReference).toMatch(TX_HASH_RE);

    // Customer lifecycle state lives in the CUSTOMER tables only.
    const w = await db.query(`SELECT crypto_status, provider_withdrawal_id FROM withdrawals WHERE id=$1`, [withdrawalId]);
    expect(w.rows[0].crypto_status).toBe('BROADCAST');
    expect(w.rows[0].provider_withdrawal_id).toBe(result.providerReference);

    // Domain separation of artifacts: no cross-pollination.
    const custArt = await db.query(`SELECT COUNT(*)::int AS n FROM treasury_custody_artifacts WHERE treasury_intent_id = $1`, [withdrawalId]);
    expect(Number(custArt.rows[0].n)).toBe(0);
    const custWdTx = await db.query(`SELECT COUNT(*)::int AS n FROM withdrawal_transactions WHERE withdrawal_id = $1`, [withdrawalId]);
    expect(Number(custWdTx.rows[0].n)).toBeGreaterThanOrEqual(1);
    const treasInWd = await db.query(
      `SELECT COUNT(*)::int AS n FROM withdrawal_transactions WHERE withdrawal_id::text LIKE 'treasury-%'`
    );
    expect(Number(treasInWd.rows[0].n)).toBe(0);

    // Nonce continuity: the customer withdrawal took the NEXT nonce after the
    // treasury transfers in the SAME hot-wallet domain.
    const nonceRow = await db.query(
      `SELECT next_nonce FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`,
      [hotWallet]
    );
    const tx = await jsonRpc.getTransaction(result.providerReference!);
    expect(tx).not.toBeNull();
    expect(parseInt(nonceRow.rows[0].next_nonce, 10)).toBeGreaterThan(tx!.nonce);
  });

  // =========================================================================
  // I. Reorg: treasury monitor reuses the Phase 10.4 reorg pattern (REORGED)
  //
  // Runs LAST (after J) because evm_revert resets the chain nonce, breaking
  // the PG nonce domain for any subsequent provider operations.
  // =========================================================================
  it('I. LIVE EVM+PG: treasury monitor marks CONFIRMED rows REORGED on chain reorganization', async () => {
    // ~54 evm_mine RPC calls plus three monitor runs — needs a longer timeout.
    // Snapshot BEFORE any fund transfer: all blocks the monitor will confirm
    // are in the reverted region, guaranteeing the walk sees a fork.
    const snapshotId = await jsonRpc.send('evm_snapshot', []);

    // Initialize the monitor's sync cursor.
    await monitor.runOnce();

    // Fund the Safe, then advance past the confirmation depth.
    await sendFunded(safeAddress, '1');
    for (let i = 0; i < 14; i++) await jsonRpc.send('evm_mine', []);
    await monitor.runOnce();

    const confirmed = await db.query(
      `SELECT tx_hash, block_number, status FROM treasury_transactions
       WHERE network='ETHEREUM' AND status='CONFIRMED' AND asset='ETH'
         AND source_address = LOWER($1) ORDER BY id DESC LIMIT 1`,
      [deployer.address]
    );
    expect(confirmed.rowCount).toBe(1); // the physical transfer to the Safe was observed

    // Reorg: revert to the snapshot taken before the fund tx.
    // After revert, the fork is at block 0; all blocks ≥ 1 were re-mined
    // with different hashes.
    await jsonRpc.send('evm_revert', [snapshotId]);

    // Mine enough blocks to rebuild the confirmation depth so the walk
    // encounters the fork (the tracked cursor block now has a different hash).
    for (let i = 0; i < 20; i++) await jsonRpc.send('evm_mine', []);

    await monitor.runOnce();

    const reorged = await db.query(
      `SELECT status FROM treasury_transactions WHERE tx_hash = $1`,
      [confirmed.rows[0].tx_hash]
    );
    expect(reorged.rows[0].status).toBe('REORGED');

    // Clean up the nonce domain (chain nonce reset to 0 by revert; PG is stale
    // for any subsequent operation — I is the last test, so this is safe).
    await db.query(
      `DELETE FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`,
      [hotWallet]
    );
  }, 120000);
});
