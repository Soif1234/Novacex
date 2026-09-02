/**
 * Phase 11K-B — F1: Duplicate Withdrawal tx_hash Concurrency Proof
 *
 * Infrastructure: LIVE PostgreSQL (disposable local instance).
 *
 * Proves the database-level guarantee that one physical blockchain transaction
 * hash can settle AT MOST ONE withdrawal under concurrent execution.
 *
 * The partial unique index uq_withdrawals_tx_hash (migration 036) is the
 * authoritative concurrency guard. Two concurrent confirmations of the SAME
 * tx_hash against DIFFERENT withdrawals both pass the application-level
 * duplicate check (neither sees the other's uncommitted row under READ
 * COMMITTED), but the second UPDATE violates the unique index. This test
 * proves that deterministic outcome with a barrier in the mocked verifier.
 *
 * Test matrix:
 *   - concurrent same-hash, two withdrawals -> exactly one commits
 *   - same tx_hash sequentially -> second rejects
 *   - same withdrawal twice -> state guard rejects
 *   - two withdrawals, different hashes -> both succeed
 *   - NULL tx_hash rows -> no constraint violation
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Must be set BEFORE the first module import so the module-level db singleton
// uses the real Postgres pool (config/database.ts line 4111-4114).
process.env.USE_REAL_PG = 'true';
process.env.CUSTODY_PROVIDER = 'manual_safe';

// Mock the on-chain verifier: the EVM evidence is tested separately. Here we
// control the verification outcome to exercise the concurrency guard.
vi.mock('../../src/services/custody/manual-tx-verification.service', () => ({
  manualTxVerificationService: {
    verifyWithdrawalTx: vi.fn(),
  },
}));

vi.mock('../../src/services/custody/custody.service', () => ({
  custodyService: {},
}));

import { PostgresDatabasePool, db as globalDb } from '../../src/config/database';
import { WithdrawalService } from '../../src/services/wallet/withdrawal.service';
import { manualTxVerificationService } from '../../src/services/custody/manual-tx-verification.service';

let db: PostgresDatabasePool;
let adminUserId: string;

const uniq = () => crypto.randomUUID().replace(/-/g, '').substring(0, 10);
// A single shared fake hash, unique per test-file load (so repeated runs on the
// same shared dev database never collide with leftover rows from a prior run).
const TX_HASH = '0x' + crypto.randomBytes(32).toString('hex');

async function createUserWithFundingAccount(): Promise<{ userId: string; accountId: string }> {
  const userId = crypto.randomUUID();
  const email = `f1con_${uniq()}@test.novacex.io`;
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
  opts?: { cryptoStatus?: string; amount?: string; destination?: string; status?: string }
): Promise<string> {
  const id = crypto.randomUUID();
  await db.query(
    `INSERT INTO withdrawals
       (id, account_id, asset, network, amount, fee, destination_address, status,
        crypto_status, created_at, updated_at)
     VALUES ($1, $2, 'ETH', 'ETHEREUM', $3, '0', $4, $5, $6, NOW(), NOW())`,
    [id, accountId, opts?.amount ?? '0.5', opts?.destination ?? '0xRecipient', opts?.status ?? 'PENDING', opts?.cryptoStatus ?? 'READY_FOR_MANUAL_EXECUTION']
  );
  return id;
}

describe('Phase 11K-B — F1: Duplicate withdrawal tx_hash concurrency', () => {
  beforeAll(async () => {
    db = new PostgresDatabasePool();
    await db.connect();
    if ((globalDb as any).connect) await (globalDb as any).connect();

    // Mutate the env singleton (it was already imported by the services above).
    const { env } = await import('../../src/config/env');
    (env as any).CUSTODY_HOT_WALLET_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
    (env as any).CUSTODY_CHAIN_ID = 1;

    // Apply migration 035 (Phase 11K schema) and 036 (F1 unique index).
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

    // Create admin user.
    adminUserId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, role, account_status, created_at, updated_at)
       VALUES ($1, $2, 'ADMIN', 'ACTIVE', NOW(), NOW())`,
      [adminUserId, `admin_f1_${uniq()}@test.novacex.io`]
    );
  });

  afterAll(async () => {
    await db.close();
    if ((globalDb as any).close) await (globalDb as any).close();
  });

  beforeEach(() => {
    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockReset();
  });

  it('A. concurrent same tx_hash on two different withdrawals — exactly one commits', async () => {
    const { accountId: acctA } = await createUserWithFundingAccount();
    const { accountId: acctB } = await createUserWithFundingAccount();
    const wA = await insertWithdrawal(acctA);
    const wB = await insertWithdrawal(acctB);

    // Barrier: both verifier calls must reach the barrier before either
    // proceeds to the UPDATE. This ensures both transactions pass the
    // application-level duplicate check (neither sees the other's uncommitted
    // row) before the DB-level unique index resolves the race.
    let release: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    let calls = 0;
    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockImplementation(async () => {
      if (++calls === 2) release!();
      await barrier;
      return { verified: true };
    });

    const service = new WithdrawalService(db as any);
    const results = await Promise.allSettled([
      service.confirmManualWithdrawal(wA, TX_HASH, adminUserId),
      service.confirmManualWithdrawal(wB, TX_HASH, adminUserId),
    ]);

    const successes = results.filter(r => r.status === 'fulfilled');
    const failures = results.filter(r => r.status === 'rejected');
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);

    // The failure must be a clean DUPLICATE_TX_HASH error.
    const fail = failures[0] as PromiseRejectedResult;
    expect(fail.reason).toBeDefined();
    const errMsg = String(fail.reason?.message ?? fail.reason);
    expect(errMsg).toMatch(/already used|DUPLICATE_TX_HASH|duplicate|unique/i);

    // Verify exactly one withdrawal is SUBMITTED with the tx_hash.
    const submitted = await db.query(
      `SELECT id, crypto_status, tx_hash FROM withdrawals
       WHERE tx_hash = $1 AND crypto_status = 'SUBMITTED'`,
      [TX_HASH]
    );
    expect(submitted.rows.length).toBe(1);
    expect(submitted.rows[0].tx_hash).toBe(TX_HASH);

    // The other must still be READY (not SUBMITTED).
    const otherId = wA === submitted.rows[0].id ? wB : wA;
    const other = await db.query(
      `SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`,
      [otherId]
    );
    expect(other.rows[0].crypto_status).toBe('READY_FOR_MANUAL_EXECUTION');
    expect(other.rows[0].tx_hash).toBeNull();

    // NO DOUBLE SETTLEMENT: now that the winner's row is committed, a re-confirm
    // of the SAME hash on the loser must be rejected by the application-level
    // duplicate guard (which now sees the committed SUBMITTED row). The loser
    // can therefore never be settled — only the single SUBMITTED row can ever
    // transition to COMPLETED via completeWithdrawal.
    await expect(
      service.confirmManualWithdrawal(otherId, TX_HASH, adminUserId)
    ).rejects.toThrow(/already used|DUPLICATE_TX_HASH|duplicate/i);

    // The winner is the only SUBMITTED row for this hash; the DB unique index
    // guarantees at most one such row exists for any hash.
    const totalSubmitted = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM withdrawals WHERE tx_hash = $1`,
      [TX_HASH]
    );
    expect(totalSubmitted.rows[0].cnt).toBe(1);
  });

  it('B. same tx_hash sequentially — second rejects', async () => {
    const { accountId } = await createUserWithFundingAccount();
    const w1 = await insertWithdrawal(accountId);
    const w2 = await insertWithdrawal(accountId);
    const hash = '0x' + crypto.randomBytes(32).toString('hex');

    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockResolvedValue({ verified: true });

    const service = new WithdrawalService(db as any);

    // First confirm succeeds.
    await service.confirmManualWithdrawal(w1, hash, adminUserId);

    // Second confirm with the same hash on a different withdrawal must reject.
    await expect(
      service.confirmManualWithdrawal(w2, hash, adminUserId)
    ).rejects.toThrow(/already used|DUPLICATE_TX_HASH|duplicate/i);
  });

  it('C. same withdrawal twice — state guard rejects second', async () => {
    const { accountId } = await createUserWithFundingAccount();
    const wid = await insertWithdrawal(accountId);
    const hash = '0x' + crypto.randomBytes(32).toString('hex');

    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockResolvedValue({ verified: true });

    const service = new WithdrawalService(db as any);

    // First confirm succeeds.
    await service.confirmManualWithdrawal(wid, hash, adminUserId);

    // Second confirm of the same withdrawal must reject (state guard: now SUBMITTED, not READY).
    await expect(
      service.confirmManualWithdrawal(wid, hash, adminUserId)
    ).rejects.toThrow(/not awaiting manual execution|INVALID_STATE/i);
  });

  it('D. two withdrawals with different hashes — both succeed', async () => {
    const { accountId } = await createUserWithFundingAccount();
    const w1 = await insertWithdrawal(accountId);
    const w2 = await insertWithdrawal(accountId);
    const hash1 = '0x' + crypto.randomBytes(32).toString('hex');
    const hash2 = '0x' + crypto.randomBytes(32).toString('hex');

    vi.mocked(manualTxVerificationService.verifyWithdrawalTx).mockResolvedValue({ verified: true });

    const service = new WithdrawalService(db as any);
    await service.confirmManualWithdrawal(w1, hash1, adminUserId);
    await service.confirmManualWithdrawal(w2, hash2, adminUserId);

    const r1 = await db.query(`SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [w1]);
    expect(r1.rows[0].crypto_status).toBe('SUBMITTED');
    expect(r1.rows[0].tx_hash).toBe(hash1);

    const r2 = await db.query(`SELECT crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [w2]);
    expect(r2.rows[0].crypto_status).toBe('SUBMITTED');
    expect(r2.rows[0].tx_hash).toBe(hash2);
  });

  it('E. NULL tx_hash rows are not constrained by the unique index', async () => {
    const { accountId } = await createUserWithFundingAccount();
    const w1 = await insertWithdrawal(accountId, { cryptoStatus: 'SUBMITTING' });
    const w2 = await insertWithdrawal(accountId, { cryptoStatus: 'SUBMITTING' });

    // Both rows have NULL tx_hash — no unique constraint violation.
    const r1 = await db.query(`SELECT tx_hash FROM withdrawals WHERE id = $1`, [w1]);
    const r2 = await db.query(`SELECT tx_hash FROM withdrawals WHERE id = $1`, [w2]);
    expect(r1.rows[0].tx_hash).toBeNull();
    expect(r2.rows[0].tx_hash).toBeNull();
  });
});