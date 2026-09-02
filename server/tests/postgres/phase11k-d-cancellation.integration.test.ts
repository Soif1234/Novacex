import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';

process.env.USE_REAL_PG = 'true';
process.env.CUSTODY_ENABLED = 'true';
process.env.CUSTODY_PROVIDER = 'manual_safe';

describe('Phase 11K-D - Cancellation Flows', () => {
  let db: any;
  let withdrawalService: any;
  let ledgerService: any;

  beforeAll(async () => {
    const dbMod = await import('../../src/config/database');
    db = new dbMod.PostgresDatabasePool();
    await db.connect(); const { SchemaMigrator } = await import('../../src/config/migrator'); await new SchemaMigrator(undefined, db).runMigrations();

    const wSvcMod = await import('../../src/services/wallet/withdrawal.service');
    withdrawalService = new wSvcMod.WithdrawalService(db);

    const lSvcMod = await import('../../src/services/ledger/ledger.service');
    ledgerService = new lSvcMod.LedgerService(db);
  });

  afterAll(async () => {
    await db.close();
  });

  const createWithdrawal = async () => {
    const userId = crypto.randomUUID();
    const accountId = crypto.randomUUID();
    const wId = crypto.randomUUID();

    await db.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `${userId}@test.com`]);
    await db.query(`INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, 'FUNDING')`, [accountId, userId]);

    // Give user balance
    await db.query(`INSERT INTO asset_networks (asset, network, is_active) VALUES ('ETH', 'ETHEREUM', TRUE) ON CONFLICT DO NOTHING`);
    await db.query(`INSERT INTO wallet_balances (account_id, asset, available_balance, locked_balance) VALUES ($1, 'ETH', '10.0', '1.1')`, [accountId]);

    await db.query(`INSERT INTO withdrawals (id, account_id, asset, network, amount, fee, destination_address, status, crypto_status) VALUES ($1, $2, 'ETH', 'ETHEREUM', '1.0', '0.1', '0x123', 'PENDING', 'APPROVED')`, [wId, accountId]);

    return { wId, accountId };
  };

  const checkBalance = async (accountId: string) => {
    const res = await db.query(`SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1`, [accountId]);
    return res.rows[0];
  };

  it('A cancel withdrawal before execution', async () => {
    const { wId, accountId } = await createWithdrawal();
    await withdrawalService.cancelWithdrawal(wId);

    const w = await db.query(`SELECT status, crypto_status FROM withdrawals WHERE id = $1`, [wId]);
    expect(w.rows[0].status).toBe('REJECTED');
    expect(w.rows[0].crypto_status).toBe('CANCELLED');

    const bal = await checkBalance(accountId);
    expect(Number(bal.available_balance)).toBe(11.1);
    expect(Number(bal.locked_balance)).toBe(0);
  });

  it('B fail withdrawal', async () => {
    const { wId, accountId } = await createWithdrawal();
    await withdrawalService.failWithdrawal(wId, 'Failed on chain');

    const w = await db.query(`SELECT status, crypto_status FROM withdrawals WHERE id = $1`, [wId]);
    expect(w.rows[0].status).toBe('FAILED');
    expect(w.rows[0].crypto_status).toBe('FAILED');

    const bal = await checkBalance(accountId);
    expect(Number(bal.available_balance)).toBe(11.1);
    expect(Number(bal.locked_balance)).toBe(0);
  });

  it('C admin resolve/release', async () => {
    const { wId, accountId } = await createWithdrawal();
    await db.query(`UPDATE withdrawals SET crypto_status = 'UNKNOWN' WHERE id = $1`, [wId]);
    withdrawalService.queryWithdrawalEvidence = async () => ({ nonBroadcast: true, confirmed: false });
    await withdrawalService.resolveWithdrawalAdmin(wId, 'admin-123', 'FAILED');

    const w = await db.query(`SELECT status, crypto_status FROM withdrawals WHERE id = $1`, [wId]);
    expect(w.rows[0].status).toBe('FAILED');
    expect(w.rows[0].crypto_status).toBe('FAILED');

    const bal = await checkBalance(accountId);
    expect(Number(bal.available_balance)).toBe(11.1);
    expect(Number(bal.locked_balance)).toBe(0);
  });

  it('D concurrent cancel attempt exactly-once release', async () => {
    const { wId, accountId } = await createWithdrawal();
    const p1 = withdrawalService.cancelWithdrawal(wId);
    const p2 = withdrawalService.cancelWithdrawal(wId);

    await Promise.allSettled([p1, p2]);

    const bal = await checkBalance(accountId);
    expect(Number(bal.available_balance)).toBe(11.1); // only released once
    expect(Number(bal.locked_balance)).toBe(0);
  });

  it('E cancel after SUBMITTED fails', async () => {
    const { wId, accountId } = await createWithdrawal();
    await db.query(`UPDATE withdrawals SET crypto_status = 'SUBMITTED' WHERE id = $1`, [wId]);

    await expect(withdrawalService.cancelWithdrawal(wId)).rejects.toThrow();

    const bal = await checkBalance(accountId);
    expect(Number(bal.locked_balance)).toBe(1.1); // still locked
  });

  it('F cancel after COMPLETED fails', async () => {
    const { wId, accountId } = await createWithdrawal();
    await db.query(`UPDATE withdrawals SET status = 'COMPLETED', crypto_status = 'COMPLETED' WHERE id = $1`, [wId]);

    await expect(withdrawalService.cancelWithdrawal(wId)).rejects.toThrow();

    const bal = await checkBalance(accountId);
    expect(Number(bal.locked_balance)).toBe(1.1); // still locked
  });

  it('G double cancel fails', async () => {
    const { wId, accountId } = await createWithdrawal();
    await withdrawalService.cancelWithdrawal(wId);
    await expect(withdrawalService.cancelWithdrawal(wId)).rejects.toThrow();

    const bal = await checkBalance(accountId);
    expect(Number(bal.available_balance)).toBe(11.1); // released once
    expect(Number(bal.locked_balance)).toBe(0);
  });

  it('H fail + retry fails', async () => {
    const { wId, accountId } = await createWithdrawal();
    await withdrawalService.failWithdrawal(wId, 'Failed');
    await withdrawalService.failWithdrawal(wId, 'Failed');

    const bal = await checkBalance(accountId);
    expect(Number(bal.available_balance)).toBe(11.1); // released once
    expect(Number(bal.locked_balance)).toBe(0);
  });

  it('I DB rollback during cancellation', async () => {
    const { wId, accountId } = await createWithdrawal();

    // Monkey patch ledger to throw
    const origPost = withdrawalService.ledger.postTransaction;
    withdrawalService.ledger.postTransaction = async () => { throw new Error('DB Crash'); };

    try {
      await withdrawalService.cancelWithdrawal(wId).catch(() => {});

      const w = await db.query(`SELECT status, crypto_status FROM withdrawals WHERE id = $1`, [wId]);
      expect(w.rows[0].status).toBe('PENDING'); // Should rollback

      const bal = await checkBalance(accountId);
      expect(Number(bal.locked_balance)).toBe(1.1); // Still locked
    } finally {
      withdrawalService.ledger.postTransaction = origPost;
    }
  });
});
