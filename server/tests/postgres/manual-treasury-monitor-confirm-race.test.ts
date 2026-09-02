/**
 * Phase 11K-B — F3: Treasury Monitor / Manual Confirmation Correlation Race
 *
 * Infrastructure: LIVE PostgreSQL (disposable local instance).
 *
 * Proves the F3 invariant: MANUAL INTENT + PHYSICAL TRANSACTION -> exactly
 * ONE treasury_transactions row, regardless of whether the on-chain monitor
 * records the physical tx before, after, or concurrently with the admin's
 * manual confirmation.
 *
 * The F3 defect (from the 11K-A audit): confirmManualTreasuryTransfer ran a
 * generic `status='CONFIRMED'` duplicate guard that rejected the monitor's
 * unlinked CONFIRMED physical row BEFORE the adoption path could run — the
 * manual intent then became permanently un-confirmable, and the monitor's
 * INSERT also deadlocked on the unique (network, tx_hash, log_index) index.
 *
 * Fixes under test:
 *   - confirm: correlates by tx_hash across ALL statuses, adopts unlinked
 *     physical rows, returns idempotently for already-linked rows, and rejects
 *     genuine cross-intent conflicts.
 *   - monitor: correlation UPDATE matches ANY row carrying the tx_hash (so
 *     confirm-first scans update the intent instead of inserting a duplicate),
 *     and parameter-based adoption links READY intents to the physical tx
 *     before falling through to an unlinked insert (which stays idempotent via
 *     ON CONFLICT DO NOTHING).
 *
 * Test matrix (spec F3):
 *   A. human confirms before monitor  -> one row, intent CONFIRMED + block info
 *   B. monitor records before confirm -> adoption, one row
 *   C. simultaneous monitor + confirm -> one row (advisory lock + unique index)
 *   D. repeated confirmation          -> idempotent, one row
 *   E. repeated monitor scan          -> no repeated insertion
 *   F. unrelated physical transfer    -> unlinked row, no false adoption
 *   G. same Safe->Safe same amount    -> unlinked row (sender mismatch blocks adoption)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Mock the on-chain verifier: EVM evidence is tested separately. Here we
// control the verification outcome to exercise the DB correlation/adoption.
vi.mock('../../src/services/custody/manual-tx-verification.service', () => ({
  manualTxVerificationService: {
    verifyTreasuryTx: vi.fn(),
  },
}));

// The treasury manager imports the custody singleton at module load; mock it to
// keep the test focused on the correlation state machine.
vi.mock('../../src/services/custody/custody.service', () => ({
  custodyService: {},
}));

import { PostgresDatabasePool, db as globalDb } from '../../src/config/database';
import { TreasuryService } from '../../src/services/treasury/treasury.service';
import { TreasuryManagerService } from '../../src/services/treasury/treasury-manager.service';
import { TreasuryMonitorService } from '../../src/services/treasury/treasury-monitor.service';
import { manualTxVerificationService } from '../../src/services/custody/manual-tx-verification.service';

let db: PostgresDatabasePool;
let adminUserId: string;

const HOT_WALLET = '0x' + '11'.repeat(20);   // CUSTODY_HOT_WALLET_ADDRESS (cold EOA)
const SAFE_ADDR = '0x' + '22'.repeat(20);    // TREASURY_SAFE_ADDRESS
const OTHER = '0x' + '33'.repeat(20);        // unrelated party
const AMOUNT = '1000000000000000000';        // 1 ETH in wei

const uniq = () => crypto.randomUUID().replace(/-/g, '').substring(0, 10);

let treasurySvc: TreasuryService;
let manager: TreasuryManagerService;
let monitor: TreasuryMonitorService;

/** Insert a READY_FOR_MANUAL_EXECUTION treasury intent row. */
async function insertIntent(opts: { amount?: string; source?: string; destination?: string } = {}): Promise<string> {
  const intentId = 'treasury-ETHEREUM-ETH-' + crypto.randomUUID();
  await db.query(
    `INSERT INTO treasury_transactions
       (network, chain_id, asset, token_contract, source_address, destination_address,
        amount, tx_hash, log_index, block_number, block_hash, status, client_withdrawal_id)
     VALUES ('ETHEREUM', '1', 'ETH', NULL, $1, $2, $3,
             NULL, 0, 0, 'PENDING', 'READY_FOR_MANUAL_EXECUTION', $4)`,
    [opts.source ?? HOT_WALLET, opts.destination ?? SAFE_ADDR, opts.amount ?? AMOUNT, intentId]
  );
  return intentId;
}

/** A physical on-chain transfer event as the monitor would emit it. */
function physicalEvent(overrides: Partial<any> = {}) {
  return {
    network: 'ETHEREUM',
    chainId: 1,
    asset: 'ETH',
    tokenContract: null,
    sourceAddress: HOT_WALLET,
    destinationAddress: SAFE_ADDR,
    amount: AMOUNT,
    txHash: '0x' + crypto.randomBytes(32).toString('hex'),
    logIndex: 0,
    blockNumber: 123,
    blockHash: '0x' + 'ee'.repeat(32),
    ...overrides,
  };
}

describe('Phase 11K-B — F3: treasury monitor/confirm correlation race', () => {
  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    db = new PostgresDatabasePool();
    await db.connect();
    if ((globalDb as any).connect) await (globalDb as any).connect();

    // Mutate the env singleton (module already imported by the services above).
    const { env } = await import('../../src/config/env');
    (env as any).CUSTODY_HOT_WALLET_ADDRESS = HOT_WALLET;
    (env as any).CUSTODY_CHAIN_ID = 1;
    process.env.TREASURY_SAFE_ADDRESS = SAFE_ADDR;
    process.env.TREASURY_SAFE_CHAIN_ID = '1';

    // Apply the Phase 11K migration so treasury audit columns + status CHECK exist.
    const migrationSql = fs.readFileSync(
      path.resolve(__dirname, '../../migrations/035_manual_safe_mode.sql'),
      'utf-8'
    ).replace(/^\uFEFF/, '');
    await db.query(migrationSql);

    // Construct services bound to the REAL pool (bypasses the module-load-time
    // InMemory singleton selection so the correlation runs on real PostgreSQL).
    treasurySvc = new TreasuryService(db as any);
    manager = new TreasuryManagerService({} as any, treasurySvc, {} as any);
    monitor = new TreasuryMonitorService(treasurySvc, {} as any, 'ETHEREUM');

    adminUserId = crypto.randomUUID();
    await db.query(
      `INSERT INTO users (id, email, role, account_status, created_at, updated_at)
       VALUES ($1, $2, 'ADMIN', 'ACTIVE', NOW(), NOW())`,
      [adminUserId, `admin_f3_${uniq()}@test.novacex.io`]
    );
  });

  afterAll(async () => {
    await db.close();
    if ((globalDb as any).close) await (globalDb as any).close();
  });

  beforeEach(async () => {
    vi.mocked(manualTxVerificationService.verifyTreasuryTx).mockReset();

    // Clean up rows created by earlier runs of this suite (or earlier tests in
    // this file) so parameter-based correlation sees exactly one matching READY
    // intent and the one-row invariants are not perturbed by stale data. Only
    // rows that this suite's markers created are removed — nothing else.
    await db.query(
      `DELETE FROM treasury_transactions
       WHERE network = 'ETHEREUM'
         AND (client_withdrawal_id LIKE 'treasury-ETHEREUM-ETH-%'
              OR block_hash = $1)`,
      ['0x' + 'ee'.repeat(32)]
    );
  });

  it('A. confirm-first: admin confirms, then monitor scans the same tx — one row, block info filled', async () => {
    const intentId = await insertIntent();
    const ev = physicalEvent();
    vi.mocked(manualTxVerificationService.verifyTreasuryTx).mockResolvedValue({ verified: true });

    // 1. Admin confirms first (intent -> CONFIRMED with tx_hash, log_index 0).
    await manager.confirmManualTreasuryTransfer(intentId, ev.txHash, adminUserId);
    let rows = await db.query(
      `SELECT id, status, tx_hash, log_index, block_number, client_withdrawal_id
       FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].status).toBe('CONFIRMED');
    expect(rows.rows[0].client_withdrawal_id).toBe(intentId);

    // 2. Monitor scans the SAME physical tx (confirm-first). The correlation
    //    UPDATE by tx_hash must match the CONFIRMED intent row, fill block info,
    //    and NOT insert a second row.
    await (monitor as any).processPhysicalTransaction(ev);

    rows = await db.query(
      `SELECT id, status, tx_hash, log_index, block_number, block_hash, client_withdrawal_id
       FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].status).toBe('CONFIRMED');
    expect(rows.rows[0].client_withdrawal_id).toBe(intentId);
    // Postgres may return block_number as numeric string.
    expect(Number(rows.rows[0].block_number)).toBe(123);
    expect(rows.rows[0].block_hash).toBe(ev.blockHash);
  });

  it('B. monitor-first: monitor adopts the READY intent by parameters — one row', async () => {
    const intentId = await insertIntent(); // source=HOT, dest=SAFE, amount=AMOUNT
    const ev = physicalEvent();            // identical parameters -> unique match

    // Monitor runs BEFORE the admin confirms.
    await (monitor as any).processPhysicalTransaction(ev);

    const rows = await db.query(
      `SELECT id, status, tx_hash, client_withdrawal_id, log_index, block_number
       FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    // Exactly ONE row: the READY intent was adopted (status CONFIRMED + tx_hash),
    // and no separate unlinked row was inserted.
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].status).toBe('CONFIRMED');
    expect(rows.rows[0].client_withdrawal_id).toBe(intentId);
    expect(rows.rows[0].tx_hash).toBe(ev.txHash);

    // Admin confirm afterwards is idempotent success (same hash already linked).
    vi.mocked(manualTxVerificationService.verifyTreasuryTx).mockResolvedValue({ verified: true });
    await expect(
      manager.confirmManualTreasuryTransfer(intentId, ev.txHash, adminUserId)
    ).resolves.toBeUndefined();

    const after = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(after.rows[0].cnt).toBe(1);
  });

  it('B2. monitor-first with unlinked physical row: confirm ADOPTS it — one row', async () => {
    // Monitor records a physical tx whose parameters do NOT uniquely match a
    // READY intent (different amount), so it lands as an unlinked CONFIRMED row.
    const intentId = await insertIntent({ amount: AMOUNT });
    const ev = physicalEvent({ amount: '999000000000000000' }); // amount mismatch
    await (monitor as any).processPhysicalTransaction(ev);

    const pre = await db.query(
      `SELECT id, status, client_withdrawal_id FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(pre.rows.length).toBe(1);
    expect(pre.rows[0].client_withdrawal_id).toBeNull(); // unlinked

    // Admin confirms with the verified tx_hash -> adoption path (delete intent,
    // reassign client_withdrawal_id to the physical row).
    vi.mocked(manualTxVerificationService.verifyTreasuryTx).mockResolvedValue({ verified: true });
    await manager.confirmManualTreasuryTransfer(intentId, ev.txHash, adminUserId);

    const after = await db.query(
      `SELECT id, status, tx_hash, client_withdrawal_id, confirmed_by
       FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(after.rows.length).toBe(1);
    expect(after.rows[0].status).toBe('CONFIRMED');
    expect(after.rows[0].client_withdrawal_id).toBe(intentId);
    expect(after.rows[0].confirmed_by).toBe(adminUserId);
  });

  it('C. simultaneous monitor + confirmation — one row, no deadlock, no duplicate', async () => {
    const intentId = await insertIntent();
    const ev = physicalEvent();

    // Barrier: pause the admin confirm inside its transaction (holding the
    // advisory lock + FOR UPDATE on the intent) while the monitor runs.
    let release: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    vi.mocked(manualTxVerificationService.verifyTreasuryTx).mockImplementation(async () => {
      await barrier;
      return { verified: true };
    });

    const confirmP = manager.confirmManualTreasuryTransfer(intentId, ev.txHash, adminUserId);
    // Let the confirm reach the verifier barrier, then run the monitor.
    await new Promise(r => setTimeout(r, 300));
    const monitorP = (monitor as any).processPhysicalTransaction(ev);
    await new Promise(r => setTimeout(r, 200));
    release!();

    await Promise.all([confirmP, monitorP]);

    const rows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows[0].cnt).toBe(1);

    const linked = await db.query(
      `SELECT client_withdrawal_id, status FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(linked.rows[0].status).toBe('CONFIRMED');
    expect(linked.rows[0].client_withdrawal_id).toBe(intentId);
  });

  it('D. repeated confirmation — idempotent, one row', async () => {
    const intentId = await insertIntent();
    const ev = physicalEvent();
    vi.mocked(manualTxVerificationService.verifyTreasuryTx).mockResolvedValue({ verified: true });

    await manager.confirmManualTreasuryTransfer(intentId, ev.txHash, adminUserId);
    await manager.confirmManualTreasuryTransfer(intentId, ev.txHash, adminUserId); // repeat

    const rows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows[0].cnt).toBe(1);
  });

  it('E. repeated monitor scan — no repeated insertion', async () => {
    const ev = physicalEvent();
    // Monitor scans the same block/tx twice (e.g. sync reset): the second pass
    // correlates by tx_hash (any status) and must not insert a duplicate.
    await (monitor as any).processPhysicalTransaction(ev);
    await (monitor as any).processPhysicalTransaction(ev);

    const rows = await db.query(
      `SELECT COUNT(*)::int AS cnt FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows[0].cnt).toBe(1);
  });

  it('F. unrelated physical transfer — unlinked row, no false adoption', async () => {
    const ev = physicalEvent({ sourceAddress: OTHER, amount: '5000000000000000000' });
    await (monitor as any).processPhysicalTransaction(ev);

    const rows = await db.query(
      `SELECT id, status, client_withdrawal_id FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].client_withdrawal_id).toBeNull();
    expect(rows.rows[0].status).toBe('CONFIRMED');
  });

  it('G. same Safe->Safe transfer with same amount — no false adoption (sender mismatch)', async () => {
    // A transfer where Safe is both sender and receiver, same amount as an
    // existing READY intent, must NOT be adopted into the intent (the intent's
    // expected sender is the hot wallet, not the Safe). It stays unlinked.
    const intentId = await insertIntent();
    const ev = physicalEvent({ sourceAddress: SAFE_ADDR, destinationAddress: SAFE_ADDR });
    await (monitor as any).processPhysicalTransaction(ev);

    const rows = await db.query(
      `SELECT id, status, client_withdrawal_id FROM treasury_transactions WHERE tx_hash = $1`,
      [ev.txHash]
    );
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0].client_withdrawal_id).toBeNull(); // not adopted

    // And the READY intent is untouched (still READY, no tx_hash).
    const intent = await db.query(
      `SELECT status, tx_hash FROM treasury_transactions WHERE client_withdrawal_id = $1`,
      [intentId]
    );
    expect(intent.rows[0].status).toBe('READY_FOR_MANUAL_EXECUTION');
    expect(intent.rows[0].tx_hash).toBeNull();
  });
});