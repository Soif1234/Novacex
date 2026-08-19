import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { PostgresDatabasePool } from '../../src/config/database';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { AuthService } from '../../src/services/auth/auth.service';
import { WalletService } from '../../src/services/wallet/wallet.service';
import { SchemaMigrator } from '../../src/config/migrator';
import {
  InsufficientBalanceError,
  ReferenceConflictError,
  InvalidAmountError,
} from '../../src/services/ledger/errors';
import { eventBus } from '../../src/services/market/event-bus';
import { MarketEvent } from '../../src/services/market/types';

describe('Real PostgreSQL Financial Integration — Ledger & Concurrency (server/tests/postgres/ledger.integration.test.ts)', () => {
  let db: PostgresDatabasePool;
  let ledgerService: LedgerService;
  let authService: AuthService;
  let walletService: WalletService;

  beforeAll(async () => {
    db = new PostgresDatabasePool();
    await db.connect();
    const migrator = new SchemaMigrator(undefined, db);
    await migrator.runMigrations();

    ledgerService = new LedgerService(db);
    authService = new AuthService(db);
    walletService = new WalletService(db, ledgerService);
  });

  afterAll(async () => {
    await db.close();
  });

  async function createTestUserWithAccount(prefix = 'pg_ledger'): Promise<{ userId: string; spotAccountId: string; fundingAccountId: string }> {
    const email = `${prefix}_${crypto.randomUUID().substring(0, 8)}@test.novacex.io`;
    const reg = await authService.signup({
      email,
      password: 'StrongPassword123!',
      username: `u_${crypto.randomUUID().substring(0, 8)}`,
      displayName: 'Test PG User',
    });

    const spotAcc = reg.user.accounts.find(a => a.type === 'SPOT')!;
    const fundingAcc = reg.user.accounts.find(a => a.type === 'FUNDING')!;

    return {
      userId: reg.user.id,
      spotAccountId: spotAcc.id,
      fundingAccountId: fundingAcc.id,
    };
  }

  // ── 1. Basic Credit ──────────────────────────────────────────────────────

  it('1. Basic Credit: increases available balance and persists ledger records in PostgreSQL', async () => {
    const { spotAccountId } = await createTestUserWithAccount('cred_basic');

    // Initial state check: no balance row yet or 0 balance
    const initBal = await ledgerService.getBalance(spotAccountId, 'USDT');
    expect(initBal.availableBalance).toBe('0.000000000000000000');
    expect(initBal.lockedBalance).toBe('0.000000000000000000');

    const refId = `ref_cred_${crypto.randomUUID()}`;
    const tx = await ledgerService.credit(
      spotAccountId,
      'USDT',
      '1000.000000000000000000',
      'DEPOSIT',
      refId,
      'Initial paper deposit'
    );

    expect(tx.transactionId).toBeDefined();
    expect(tx.entries.length).toBe(1);
    expect(tx.entries[0].direction).toBe('CREDIT');
    expect(tx.entries[0].amount).toBe('1000.000000000000000000');
    expect(tx.entries[0].balanceAfter).toBe('1000.000000000000000000');

    // Direct SQL verification in PostgreSQL
    const balRow = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows.length).toBe(1);
    expect(balRow.rows[0].available_balance).toBe('1000.000000000000000000');
    expect(balRow.rows[0].locked_balance).toBe('0.000000000000000000');

    // Direct SQL ledger_transactions check
    const txRow = await db.query<any>(
      'SELECT id, account_id, transaction_type, reference_id FROM ledger_transactions WHERE reference_id = $1',
      [refId]
    );
    expect(txRow.rows.length).toBe(1);
    expect(txRow.rows[0].transaction_type).toBe('DEPOSIT');

    // Direct SQL ledger_entries check
    const entryRows = await db.query<any>(
      'SELECT direction, asset, amount, balance_after FROM ledger_entries WHERE transaction_id = $1',
      [tx.transactionId]
    );
    expect(entryRows.rows.length).toBe(1);
    expect(entryRows.rows[0].direction).toBe('CREDIT');
    expect(entryRows.rows[0].amount).toBe('1000.000000000000000000');
  });

  // ── 2. Real Debit ────────────────────────────────────────────────────────

  it('2. Real Debit: decreases available balance and creates debit journal in PostgreSQL', async () => {
    const { spotAccountId } = await createTestUserWithAccount('deb_basic');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');

    const debRef = `ref_deb_${crypto.randomUUID()}`;
    const tx = await ledgerService.debit(
      spotAccountId,
      'USDT',
      '300.000000000000000000',
      'WITHDRAWAL',
      debRef,
      'Debit 300'
    );

    expect(tx.entries[0].direction).toBe('DEBIT');
    expect(tx.entries[0].amount).toBe('300.000000000000000000');
    expect(tx.entries[0].balanceAfter).toBe('700.000000000000000000');

    // Direct SQL check
    const balRow = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].available_balance).toBe('700.000000000000000000');
    expect(balRow.rows[0].locked_balance).toBe('0.000000000000000000');
  });

  // ── 3. Real Reserve ──────────────────────────────────────────────────────

  it('3. Real Reserve: moves available to locked balance with double-entry records', async () => {
    const { spotAccountId } = await createTestUserWithAccount('res_basic');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');

    const resRef = `ref_res_${crypto.randomUUID()}`;
    const tx = await ledgerService.reserve(
      spotAccountId,
      'USDT',
      '400.000000000000000000',
      'SPOT_ORDER_LOCK',
      resRef,
      'Reserve 400'
    );

    expect(tx.entries.length).toBe(2);
    expect(tx.entries[0].direction).toBe('DEBIT');
    expect(tx.entries[1].direction).toBe('CREDIT');

    // Direct SQL check
    const balRow = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].available_balance).toBe('600.000000000000000000');
    expect(balRow.rows[0].locked_balance).toBe('400.000000000000000000');
  });

  // ── 4. Real Release ──────────────────────────────────────────────────────

  it('4. Real Release: moves locked back to available balance in PostgreSQL', async () => {
    const { spotAccountId } = await createTestUserWithAccount('rel_basic');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');
    await ledgerService.reserve(spotAccountId, 'USDT', '400.000000000000000000', 'SPOT_ORDER_LOCK', `ref_r_${crypto.randomUUID()}`, 'Reserve');

    const relRef = `ref_rel_${crypto.randomUUID()}`;
    const tx = await ledgerService.release(
      spotAccountId,
      'USDT',
      '150.000000000000000000',
      'SPOT_ORDER_UNLOCK',
      relRef,
      'Release 150'
    );

    expect(tx.entries.length).toBe(2);

    // Direct SQL check
    const balRow = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].available_balance).toBe('750.000000000000000000');
    expect(balRow.rows[0].locked_balance).toBe('250.000000000000000000');
  });

  // ── 5. Insufficient Balance Rejection ─────────────────────────────────────

  it('5. Insufficient available balance is rejected and leaves zero partial mutations', async () => {
    const { spotAccountId } = await createTestUserWithAccount('insuf_av');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');

    const failRef = `ref_fail_${crypto.randomUUID()}`;
    await expect(
      ledgerService.debit(spotAccountId, 'USDT', '1001.000000000000000000', 'WITHDRAWAL', failRef, 'Over debit')
    ).rejects.toThrow(InsufficientBalanceError);

    // Direct SQL check
    const balRow = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].available_balance).toBe('1000.000000000000000000');
    expect(balRow.rows[0].locked_balance).toBe('0.000000000000000000');

    // No orphan records in PostgreSQL
    const txRow = await db.query<any>(
      'SELECT COUNT(*) as count FROM ledger_transactions WHERE reference_id = $1',
      [failRef]
    );
    expect(Number(txRow.rows[0].count)).toBe(0);
  });

  it('6. Insufficient locked balance is rejected on release', async () => {
    const { spotAccountId } = await createTestUserWithAccount('insuf_lk');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');
    await ledgerService.reserve(spotAccountId, 'USDT', '400.000000000000000000', 'SPOT_ORDER_LOCK', `ref_r_${crypto.randomUUID()}`, 'Reserve');

    const failRef = `ref_fail_rel_${crypto.randomUUID()}`;
    await expect(
      ledgerService.release(spotAccountId, 'USDT', '401.000000000000000000', 'SPOT_ORDER_UNLOCK', failRef, 'Over release')
    ).rejects.toThrow(InsufficientBalanceError);

    const balRow = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].locked_balance).toBe('400.000000000000000000');
  });

  // ── 6. Invalid Amounts Validation ────────────────────────────────────────

  it('7. Invalid amounts (zero, negative, malformed) are rejected without DB mutation', async () => {
    const { spotAccountId } = await createTestUserWithAccount('invalid_amt');
    await ledgerService.credit(spotAccountId, 'USDT', '100.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');

    await expect(
      ledgerService.credit(spotAccountId, 'USDT', '0', 'DEPOSIT', `ref_${crypto.randomUUID()}`, 'Zero')
    ).rejects.toThrow(InvalidAmountError);

    await expect(
      ledgerService.credit(spotAccountId, 'USDT', '-50.00', 'DEPOSIT', `ref_${crypto.randomUUID()}`, 'Negative')
    ).rejects.toThrow(InvalidAmountError);

    await expect(
      ledgerService.credit(spotAccountId, 'USDT', 'not-a-number', 'DEPOSIT', `ref_${crypto.randomUUID()}`, 'Malformed')
    ).rejects.toThrow(InvalidAmountError);

    const balRow = await db.query<any>(
      'SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].available_balance).toBe('100.000000000000000000');
  });

  // ── 7. Real PostgreSQL Idempotency & Conflict ────────────────────────────

  it('8. Real Idempotency: exact same reference returns existing result without double balance mutation', async () => {
    const { spotAccountId } = await createTestUserWithAccount('idemp_test');
    const refId = `ledger_test_R1_${crypto.randomUUID()}`;

    const res1 = await ledgerService.credit(spotAccountId, 'USDT', '500.000000000000000000', 'DEPOSIT', refId, 'Idempotent deposit');
    const res2 = await ledgerService.credit(spotAccountId, 'USDT', '500.000000000000000000', 'DEPOSIT', refId, 'Idempotent deposit');

    expect(res1.transactionId).toBe(res2.transactionId);

    // Verify exactly one balance row mutation
    const balRow = await db.query<any>(
      'SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
    expect(balRow.rows[0].available_balance).toBe('500.000000000000000000');

    // Verify exactly one transaction in PostgreSQL
    const txRows = await db.query<any>(
      'SELECT COUNT(*) as count FROM ledger_transactions WHERE reference_id = $1',
      [refId]
    );
    expect(Number(txRows.rows[0].count)).toBe(1);

    // Reuse same reference with different parameters -> ReferenceConflictError
    await expect(
      ledgerService.credit(spotAccountId, 'USDT', '600.000000000000000000', 'DEPOSIT', refId, 'Different amount')
    ).rejects.toThrow(ReferenceConflictError);
  });

  // ── 8. Real Atomic Cross-Account Transfer ────────────────────────────────

  it('9. Real Atomic Transfer: A -> B moves funds atomically in single transaction', async () => {
    const userA = await createTestUserWithAccount('transfer_src');
    const userB = await createTestUserWithAccount('transfer_dst');

    await ledgerService.credit(userA.spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit A');

    const transferRef = `ref_xfer_${crypto.randomUUID()}`;
    const tx = await ledgerService.transfer(
      userA.spotAccountId,
      userB.spotAccountId,
      'USDT',
      '400.000000000000000000',
      transferRef,
      'Transfer 400 from A to B'
    );

    expect(tx.entries.length).toBe(2);

    // Direct SQL check on both accounts
    const balA = await db.query<any>('SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [userA.spotAccountId, 'USDT']);
    const balB = await db.query<any>('SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [userB.spotAccountId, 'USDT']);

    expect(balA.rows[0].available_balance).toBe('600.000000000000000000');
    expect(balB.rows[0].available_balance).toBe('400.000000000000000000');

    // Direct SQL check on ledger_entries: both belong to the same transaction_id
    const entries = await db.query<any>('SELECT account_id, direction, amount FROM ledger_entries WHERE transaction_id = $1', [tx.transactionId]);
    expect(entries.rows.length).toBe(2);
  });

  it('10. Transfer Rollback: error during transfer leaves zero orphan mutations in PostgreSQL', async () => {
    const userA = await createTestUserWithAccount('xfer_roll_a');
    const userB = await createTestUserWithAccount('xfer_roll_b');

    await ledgerService.credit(userA.spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit A');

    const refId = `ref_fail_xfer_${crypto.randomUUID()}`;

    let caught = false;
    try {
      await db.transaction(async (txClient) => {
        await txClient.query(
          'UPDATE wallet_balances SET available_balance = available_balance - 400 WHERE account_id = $1 AND asset = $2',
          [userA.spotAccountId, 'USDT']
        );
        const txId = crypto.randomUUID();
        await txClient.query(
          'INSERT INTO ledger_transactions (id, account_id, transaction_type, reference_id, description) VALUES ($1, $2, $3, $4, $5)',
          [txId, userA.spotAccountId, 'INTERNAL_TRANSFER', refId, 'Failing transfer']
        );
        throw new Error('Forced failure midway through transfer');
      });
    } catch {
      caught = true;
    }

    expect(caught).toBe(true);

    const balA = await db.query<any>('SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [userA.spotAccountId, 'USDT']);
    expect(balA.rows[0].available_balance).toBe('1000.000000000000000000');

    const txRows = await db.query<any>('SELECT COUNT(*) as count FROM ledger_transactions WHERE reference_id = $1', [refId]);
    expect(Number(txRows.rows[0].count)).toBe(0);
  });

  // ── 9. Real Multi-Connection Concurrency Tests ───────────────────────────

  it('11. Real Concurrent Debit: two connections debit 700 from 1000 USDT — exactly ONE succeeds', async () => {
    const { spotAccountId } = await createTestUserWithAccount('conc_deb');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');

    const pool1 = new PostgresDatabasePool();
    const pool2 = new PostgresDatabasePool();
    const service1 = new LedgerService(pool1);
    const service2 = new LedgerService(pool2);

    try {
      const p1 = service1.debit(spotAccountId, 'USDT', '700.000000000000000000', 'WITHDRAWAL', `ref_d1_${crypto.randomUUID()}`, 'Debit 1');
      const p2 = service2.debit(spotAccountId, 'USDT', '700.000000000000000000', 'WITHDRAWAL', `ref_d2_${crypto.randomUUID()}`, 'Debit 2');

      const results = await Promise.allSettled([p1, p2]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(InsufficientBalanceError);

      const balRow = await db.query<any>('SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [spotAccountId, 'USDT']);
      expect(balRow.rows[0].available_balance).toBe('300.000000000000000000');
      expect(balRow.rows[0].locked_balance).toBe('0.000000000000000000');
    } finally {
      await pool1.close();
      await pool2.close();
    }
  });

  it('12. Real Concurrent Reserve: two connections reserve 700 from 1000 USDT — exactly ONE succeeds', async () => {
    const { spotAccountId } = await createTestUserWithAccount('conc_res');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');

    const pool1 = new PostgresDatabasePool();
    const pool2 = new PostgresDatabasePool();
    const service1 = new LedgerService(pool1);
    const service2 = new LedgerService(pool2);

    try {
      const p1 = service1.reserve(spotAccountId, 'USDT', '700.000000000000000000', 'SPOT_ORDER_LOCK', `ref_r1_${crypto.randomUUID()}`, 'Reserve 1');
      const p2 = service2.reserve(spotAccountId, 'USDT', '700.000000000000000000', 'SPOT_ORDER_LOCK', `ref_r2_${crypto.randomUUID()}`, 'Reserve 2');

      const results = await Promise.allSettled([p1, p2]);

      const fulfilled = results.filter(r => r.status === 'fulfilled');
      const rejected = results.filter(r => r.status === 'rejected');

      expect(fulfilled.length).toBe(1);
      expect(rejected.length).toBe(1);

      const balRow = await db.query<any>('SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [spotAccountId, 'USDT']);
      expect(balRow.rows[0].available_balance).toBe('300.000000000000000000');
      expect(balRow.rows[0].locked_balance).toBe('700.000000000000000000');
    } finally {
      await pool1.close();
      await pool2.close();
    }
  });

  it('13. Real Opposite Transfer Concurrency: A->B and B->A complete without deadlock', async () => {
    const userA = await createTestUserWithAccount('opp_xfer_a');
    const userB = await createTestUserWithAccount('opp_xfer_b');

    await ledgerService.credit(userA.spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_ca_${crypto.randomUUID()}`, 'Credit A');
    await ledgerService.credit(userB.spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_cb_${crypto.randomUUID()}`, 'Credit B');

    const pool1 = new PostgresDatabasePool();
    const pool2 = new PostgresDatabasePool();
    const service1 = new LedgerService(pool1);
    const service2 = new LedgerService(pool2);

    try {
      const p1 = service1.transfer(
        userA.spotAccountId,
        userB.spotAccountId,
        'USDT',
        '100.000000000000000000',
        `ref_ab_${crypto.randomUUID()}`,
        'Transfer A to B'
      );
      const p2 = service2.transfer(
        userB.spotAccountId,
        userA.spotAccountId,
        'USDT',
        '200.000000000000000000',
        `ref_ba_${crypto.randomUUID()}`,
        'Transfer B to A'
      );

      const results = await Promise.allSettled([p1, p2]);

      expect(results[0].status).toBe('fulfilled');
      expect(results[1].status).toBe('fulfilled');

      const balA = await db.query<any>('SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [userA.spotAccountId, 'USDT']);
      const balB = await db.query<any>('SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2', [userB.spotAccountId, 'USDT']);

      // A: 1000 - 100 + 200 = 1100
      // B: 1000 + 100 - 200 = 900
      // Total: 2000
      expect(balA.rows[0].available_balance).toBe('1100.000000000000000000');
      expect(balB.rows[0].available_balance).toBe('900.000000000000000000');
    } finally {
      await pool1.close();
      await pool2.close();
    }
  });

  // ── 10. Real Reconciliation ──────────────────────────────────────────────

  it('14. Real Reconciliation: detects discrepancies and validates consistent states', async () => {
    const { spotAccountId } = await createTestUserWithAccount('reconcile_user');
    await ledgerService.credit(spotAccountId, 'USDT', '1000.000000000000000000', 'DEPOSIT', `ref_c_${crypto.randomUUID()}`, 'Credit');
    await ledgerService.debit(spotAccountId, 'USDT', '200.000000000000000000', 'WITHDRAWAL', `ref_d_${crypto.randomUUID()}`, 'Debit');
    await ledgerService.reserve(spotAccountId, 'USDT', '300.000000000000000000', 'SPOT_ORDER_LOCK', `ref_r_${crypto.randomUUID()}`, 'Reserve');

    // 1. Consistent state
    const reconClean = await ledgerService.reconcile(spotAccountId, 'USDT');
    expect(reconClean.isConsistent).toBe(true);
    expect(reconClean.discrepancy).toBe('0.000000000000000000');
    expect(reconClean.walletTotal).toBe('800.000000000000000000');
    expect(reconClean.ledgerComputedBalance).toBe('800.000000000000000000');

    // 2. Deliberate inconsistency via direct SQL manipulation (untracked balance inflation)
    await db.query(
      'UPDATE wallet_balances SET available_balance = available_balance + 50 WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );

    const reconDiscrepant = await ledgerService.reconcile(spotAccountId, 'USDT');
    expect(reconDiscrepant.isConsistent).toBe(false);
    expect(reconDiscrepant.discrepancy).toBe('50.000000000000000000');

    // Revert direct manipulation
    await db.query(
      'UPDATE wallet_balances SET available_balance = available_balance - 50 WHERE account_id = $1 AND asset = $2',
      [spotAccountId, 'USDT']
    );
  });

  // ── 11. User / Account Authorization & Isolation ─────────────────────────

  it('15. User / Account Isolation: User A cannot access or mutate User B resources', async () => {
    const userA = await createTestUserWithAccount('iso_a');
    const userB = await createTestUserWithAccount('iso_b');

    await ledgerService.credit(userB.spotAccountId, 'USDT', '500.000000000000000000', 'DEPOSIT', `ref_b_${crypto.randomUUID()}`, 'User B Deposit');

    // User A cannot read User B's balances
    await expect(
      walletService.getBalances(userA.userId, userB.spotAccountId)
    ).rejects.toThrow();

    // User A cannot transfer out of User B's account
    await expect(
      walletService.transfer({
        userId: userA.userId,
        fromAccountId: userB.spotAccountId,
        toAccountId: userA.spotAccountId,
        asset: 'USDT',
        amount: '100',
        referenceId: `ref_hack_${crypto.randomUUID()}`,
      })
    ).rejects.toThrow();
  });

  // ── 12. Post-Commit Events ───────────────────────────────────────────────

  it('16. Post-Commit Events: events emitted only after successful commit, zero on rollback', async () => {
    const { spotAccountId } = await createTestUserWithAccount('evt_user');
    const receivedEvents: MarketEvent[] = [];

    const unsub = eventBus.subscribe('ledger.transaction.posted', (evt) => {
      receivedEvents.push(evt);
    });

    try {
      // 1. Successful commit
      const successRef = `ref_evt_ok_${crypto.randomUUID()}`;
      await ledgerService.credit(spotAccountId, 'USDT', '250.000000000000000000', 'DEPOSIT', successRef, 'Event test success');
      expect(receivedEvents.length).toBe(1);
      const payload = receivedEvents[0].payload as any;
      expect(payload.referenceId).toBe(successRef);
      expect(payload.entries[0].balanceAfter).toBe('250.000000000000000000');

      // 2. Failed transaction (Insufficient balance)
      const failRef = `ref_evt_fail_${crypto.randomUUID()}`;
      await expect(
        ledgerService.debit(spotAccountId, 'USDT', '99999.000000000000000000', 'WITHDRAWAL', failRef, 'Event test fail')
      ).rejects.toThrow();

      // No second event emitted
      expect(receivedEvents.length).toBe(1);
    } finally {
      unsub();
    }
  });
});
