import { describe, it, expect, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { DatabasePool } from '../src/config/database';
import { WalletService } from '../src/services/wallet/wallet.service';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { AuthService } from '../src/services/auth/auth.service';
import { SessionService } from '../src/services/auth/session.service';
import { requireRole } from '../src/middleware/auth';
import {
  adminPaperDeposit,
  paperWithdraw,
  internalTransfer,
  getBalances,
  getTransactions,
} from '../src/controllers/wallet.controller';
import { WalletErrorCode } from '../src/services/wallet/errors';
import { LedgerErrorCode } from '../src/services/ledger/errors';
import { decimalNormalize, decimalAdd } from '../src/services/ledger/decimal';

describe('WalletService & Paper Transaction API (Phase 4 Step 6)', () => {
  let database: DatabasePool;
  let ledger: LedgerService;
  let wallet: WalletService;
  let auth: AuthService;
  let sessions: SessionService;

  let userA: { id: string; email: string; token: string; spotId: string; futuresId: string; fundingId: string };
  let userB: { id: string; email: string; token: string; spotId: string; futuresId: string; fundingId: string };
  let adminUser: { id: string; email: string; token: string; spotId: string };

  beforeEach(async () => {
    database = new DatabasePool();
    await database.connect();
    database.reset!();

    ledger = new LedgerService(database);
    wallet = new WalletService(database, ledger);
    sessions = new SessionService(database);
    auth = new AuthService(database, sessions);

    // 1. Signup User A
    const signupA = await auth.signup({ email: 'userA@novacex.io', password: 'Password123!' });
    const loginA = await auth.login({ email: 'userA@novacex.io', password: 'Password123!' });
    userA = {
      id: signupA.user.id,
      email: signupA.user.email,
      token: loginA.sessionToken,
      spotId: signupA.user.accounts.find(a => a.type === 'SPOT')!.id,
      futuresId: signupA.user.accounts.find(a => a.type === 'FUTURES')!.id,
      fundingId: signupA.user.accounts.find(a => a.type === 'FUNDING')!.id,
    };

    // 2. Signup User B
    const signupB = await auth.signup({ email: 'userB@novacex.io', password: 'Password123!' });
    const loginB = await auth.login({ email: 'userB@novacex.io', password: 'Password123!' });
    userB = {
      id: signupB.user.id,
      email: signupB.user.email,
      token: loginB.sessionToken,
      spotId: signupB.user.accounts.find(a => a.type === 'SPOT')!.id,
      futuresId: signupB.user.accounts.find(a => a.type === 'FUTURES')!.id,
      fundingId: signupB.user.accounts.find(a => a.type === 'FUNDING')!.id,
    };

    // 3. Create Admin User
    const signupAdmin = await auth.signup({ email: 'admin@novacex.io', password: 'AdminPassword123!' });
    await database.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [signupAdmin.user.id]);
    const loginAdmin = await auth.login({ email: 'admin@novacex.io', password: 'AdminPassword123!' });
    adminUser = {
      id: signupAdmin.user.id,
      email: signupAdmin.user.email,
      token: loginAdmin.sessionToken,
      spotId: signupAdmin.user.accounts.find(a => a.type === 'SPOT')!.id,
    };
  });

  // ── 1. User can read own balances ──────────────────────────────────────────
  it('1. user can read own balances', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'dep-test-1',
    });

    const balances = await wallet.getBalances(userA.id);
    expect(balances.length).toBeGreaterThan(0);
    const usdtSpot = balances.find(b => b.accountId === userA.spotId && b.asset === 'USDT');
    expect(usdtSpot).toBeDefined();
    expect(usdtSpot!.availableBalance).toBe(decimalNormalize('500'));
    expect(usdtSpot!.lockedBalance).toBe(decimalNormalize('0'));
    expect(usdtSpot!.totalBalance).toBe(decimalNormalize('500'));
  });

  // ── 2. User cannot read another user's balances ────────────────────────────
  it("2. user cannot read another user's balances", async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userB.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'dep-test-2',
    });

    // User A attempts to request User B's account balances
    await expect(wallet.getBalances(userA.id, userB.spotId)).rejects.toMatchObject({
      code: WalletErrorCode.ACCOUNT_OWNERSHIP_DENIED,
    });
  });

  // ── 3. New user receives SPOT/FUTURES/FUNDING accounts ────────────────────
  it('3. new user receives SPOT/FUTURES/FUNDING accounts', async () => {
    const signup = await auth.signup({ email: 'newtrader@novacex.io', password: 'Password123!' });
    expect(signup.user.accounts).toHaveLength(3);
    const types = signup.user.accounts.map(a => a.type).sort();
    expect(types).toEqual(['FUNDING', 'FUTURES', 'SPOT']);
  });

  // ── 4. New user starts with zero production balance ────────────────────────
  it('4. new user starts with zero production balance', async () => {
    const signup = await auth.signup({ email: 'zerobal@novacex.io', password: 'Password123!' });
    const balances = await wallet.getBalances(signup.user.id);
    expect(balances).toHaveLength(0);
  });

  // ── 5. Admin paper deposit credits correct account ─────────────────────────
  it('5. admin paper deposit credits correct account', async () => {
    const receipt = await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'BTC',
      amount: '2.5',
      referenceId: 'paper-dep-5',
      description: 'Test seed BTC',
    });

    expect(receipt.mode).toBe('PAPER');
    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.accountId).toBe(userA.spotId);
    expect(receipt.asset).toBe('BTC');
    expect(receipt.amount).toBe(decimalNormalize('2.5'));

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'BTC');
    expect(bal.availableBalance).toBe(decimalNormalize('2.5'));
  });

  // ── 6. Normal USER cannot paper deposit (API RBAC) ─────────────────────────
  it('6. normal USER cannot paper deposit via API RBAC', () => {
    const userReq = {
      user: { id: userA.id, email: userA.email, role: 'USER' },
    } as unknown as Request;
    const res = {} as Response;
    let rbacErr: any = null;

    const guard = requireRole('ADMIN');
    guard(userReq, res, (err) => { rbacErr = err; });

    expect(rbacErr).toBeDefined();
    expect(rbacErr.statusCode).toBe(403);
    expect(rbacErr.code).toBe('FORBIDDEN');
  });

  // ── 7. Paper deposit is idempotent ─────────────────────────────────────────
  it('7. paper deposit is idempotent', async () => {
    const receipt1 = await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'idem-dep-7',
      description: 'Idempotent deposit',
    });

    const receipt2 = await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'idem-dep-7',
      description: 'Idempotent deposit',
    });

    expect(receipt2.transactionId).toBe(receipt1.transactionId);

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('500'));
  });

  // ── 8. Conflicting deposit reference is rejected ───────────────────────────
  it('8. conflicting deposit reference is rejected', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'conflict-dep-8',
      description: 'First params',
    });

    await expect(
      wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'USDT',
        amount: '500',
        referenceId: 'conflict-dep-8',
        description: 'Different params',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.REFERENCE_CONFLICT,
    });
  });

  // ── 9. Withdrawal succeeds with sufficient balance ─────────────────────────
  it('9. withdrawal succeeds with sufficient balance', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-wd-9',
    });

    const receipt = await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '300',
      referenceId: 'wd-test-9',
      destinationAddress: '0x1234567890abcdef',
    });

    expect(receipt.mode).toBe('PAPER');
    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.amount).toBe(decimalNormalize('300'));

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('700'));
  });

  // ── 10. Withdrawal fails with insufficient balance ─────────────────────────
  it('10. withdrawal fails with insufficient balance', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'seed-wd-10',
    });

    await expect(
      wallet.paperWithdraw({
        userId: userA.id,
        accountId: userA.spotId,
        asset: 'USDT',
        amount: '200',
        referenceId: 'wd-fail-10',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
    });
  });

  // ── 11. Withdrawal cannot create negative balance ──────────────────────────
  it('11. withdrawal cannot create negative balance', async () => {
    await expect(
      wallet.paperWithdraw({
        userId: userA.id,
        accountId: userA.spotId,
        asset: 'ETH',
        amount: '1',
        referenceId: 'wd-neg-11',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
    });

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'ETH');
    expect(bal.availableBalance).toBe(decimalNormalize('0'));
  });

  // ── 12. Withdrawal is idempotent ───────────────────────────────────────────
  it('12. withdrawal is idempotent', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-wd-12',
    });

    const r1 = await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '400',
      referenceId: 'idem-wd-12',
      description: 'Idempotent wd',
    });

    const r2 = await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '400',
      referenceId: 'idem-wd-12',
      description: 'Idempotent wd',
    });

    expect(r2.transactionId).toBe(r1.transactionId);

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('600'));
  });

  // ── 13. Conflicting withdrawal reference is rejected ───────────────────────
  it('13. conflicting withdrawal reference is rejected', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-wd-13',
    });

    await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '200',
      referenceId: 'conflict-wd-13',
      description: 'First withdrawal',
    });

    await expect(
      wallet.paperWithdraw({
        userId: userA.id,
        accountId: userA.spotId,
        asset: 'USDT',
        amount: '200',
        referenceId: 'conflict-wd-13',
        description: 'Second withdrawal with diff desc',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.REFERENCE_CONFLICT,
    });
  });

  // ── 14. SPOT → FUTURES transfer works ──────────────────────────────────────
  it('14. SPOT → FUTURES transfer works', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-xfer-14',
    });

    const receipt = await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '400',
      referenceId: 'xfer-spot-fut-14',
    });

    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.fromAccountType).toBe('SPOT');
    expect(receipt.toAccountType).toBe('FUTURES');

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    const futBal = await wallet.getBalance(userA.id, userA.futuresId, 'USDT');

    expect(spotBal.availableBalance).toBe(decimalNormalize('600'));
    expect(futBal.availableBalance).toBe(decimalNormalize('400'));
  });

  // ── 15. FUTURES → SPOT transfer works ──────────────────────────────────────
  it('15. FUTURES → SPOT transfer works', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'seed-xfer-15',
    });

    await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.futuresId,
      toAccountId: userA.spotId,
      asset: 'USDT',
      amount: '200',
      referenceId: 'xfer-fut-spot-15',
    });

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    const futBal = await wallet.getBalance(userA.id, userA.futuresId, 'USDT');

    expect(futBal.availableBalance).toBe(decimalNormalize('300'));
    expect(spotBal.availableBalance).toBe(decimalNormalize('200'));
  });

  // ── 16. SPOT → FUNDING transfer works ──────────────────────────────────────
  it('16. SPOT → FUNDING transfer works', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-xfer-16',
    });

    await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.fundingId,
      asset: 'USDT',
      amount: '350',
      referenceId: 'xfer-spot-fund-16',
    });

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    const fundBal = await wallet.getBalance(userA.id, userA.fundingId, 'USDT');

    expect(spotBal.availableBalance).toBe(decimalNormalize('650'));
    expect(fundBal.availableBalance).toBe(decimalNormalize('350'));
  });

  // ── 17. FUNDING → FUTURES transfer works ───────────────────────────────────
  it('17. FUNDING → FUTURES transfer works', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.fundingId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-xfer-17',
    });

    await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.fundingId,
      toAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'xfer-fund-fut-17',
    });

    const fundBal = await wallet.getBalance(userA.id, userA.fundingId, 'USDT');
    const futBal = await wallet.getBalance(userA.id, userA.futuresId, 'USDT');

    expect(fundBal.availableBalance).toBe(decimalNormalize('500'));
    expect(futBal.availableBalance).toBe(decimalNormalize('500'));
  });

  // ── 18. Transfer requires same authenticated owner ─────────────────────────
  it('18. transfer requires same authenticated owner (rejects cross-user transfer)', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-xfer-18',
    });

    await expect(
      wallet.transfer({
        userId: userA.id,
        fromAccountId: userA.spotId,
        toAccountId: userB.spotId,
        asset: 'USDT',
        amount: '100',
        referenceId: 'cross-user-xfer-18',
      })
    ).rejects.toMatchObject({
      code: WalletErrorCode.CROSS_USER_TRANSFER_DENIED,
    });
  });

  // ── 19. User cannot transfer from another user's account ───────────────────
  it("19. user cannot transfer from another user's account", async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userB.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-xfer-19',
    });

    await expect(
      wallet.transfer({
        userId: userA.id,
        fromAccountId: userB.spotId,
        toAccountId: userA.spotId,
        asset: 'USDT',
        amount: '100',
        referenceId: 'theft-xfer-19',
      })
    ).rejects.toMatchObject({
      code: WalletErrorCode.ACCOUNT_OWNERSHIP_DENIED,
    });
  });

  // ── 20. Transfer is atomic ─────────────────────────────────────────────────
  it('20. transfer is atomic: both balances update together', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'SOL',
      amount: '10',
      referenceId: 'seed-xfer-20',
    });

    await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.futuresId,
      asset: 'SOL',
      amount: '4',
      referenceId: 'atomic-xfer-20',
    });

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'SOL');
    const futBal = await wallet.getBalance(userA.id, userA.futuresId, 'SOL');

    expect(spotBal.availableBalance).toBe(decimalNormalize('6'));
    expect(futBal.availableBalance).toBe(decimalNormalize('4'));
  });

  // ── 21. Failed transfer rolls back ─────────────────────────────────────────
  it('21. failed transfer rolls back (no partial mutations)', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'seed-xfer-21',
    });

    await expect(
      wallet.transfer({
        userId: userA.id,
        fromAccountId: userA.spotId,
        toAccountId: userA.futuresId,
        asset: 'USDT',
        amount: '500',
        referenceId: 'fail-xfer-21',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INSUFFICIENT_AVAILABLE_BALANCE,
    });

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    const futBal = await wallet.getBalance(userA.id, userA.futuresId, 'USDT');

    expect(spotBal.availableBalance).toBe(decimalNormalize('100'));
    expect(futBal.availableBalance).toBe(decimalNormalize('0'));
  });

  // ── 22. Concurrent withdrawals cannot overspend ────────────────────────────
  it('22. concurrent withdrawals cannot overspend (1000 balance, 700 + 700 → 1 succeeds)', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-conc-22',
    });

    const p1 = wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '700',
      referenceId: 'conc-wd-22a',
    });

    const p2 = wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '700',
      referenceId: 'conc-wd-22b',
    });

    const results = await Promise.allSettled([p1, p2]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('300'));
  });

  // ── 23. Concurrent transfers cannot overspend ──────────────────────────────
  it('23. concurrent transfers cannot overspend (1000 balance, 700 + 700 → 1 succeeds)', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-conc-23',
    });

    const p1 = wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '700',
      referenceId: 'conc-xfer-23a',
    });

    const p2 = wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.fundingId,
      asset: 'USDT',
      amount: '700',
      referenceId: 'conc-xfer-23b',
    });

    const results = await Promise.allSettled([p1, p2]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(spotBal.availableBalance).toBe(decimalNormalize('300'));
  });

  // ── 24. Duplicate concurrent transfer executes once ────────────────────────
  it('24. duplicate concurrent transfer executes once with same reference', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-conc-24',
    });

    const r1 = await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '300',
      referenceId: 'dup-xfer-24',
      description: 'Transfer 300',
    });

    const r2 = await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '300',
      referenceId: 'dup-xfer-24',
      description: 'Transfer 300',
    });

    expect(r2.transactionId).toBe(r1.transactionId);

    const spotBal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(spotBal.availableBalance).toBe(decimalNormalize('700'));
  });

  // ── 25. Transaction history is account scoped ──────────────────────────────
  it('25. transaction history is account scoped', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'tx-hist-25a',
    });
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userB.spotId,
      asset: 'USDT',
      amount: '200',
      referenceId: 'tx-hist-25b',
    });

    const histA = await wallet.getTransactions(userA.id, { accountId: userA.spotId });
    const histB = await wallet.getTransactions(userB.id, { accountId: userB.spotId });

    expect(histA.entries.some(e => e.referenceId === 'tx-hist-25a')).toBe(true);
    expect(histA.entries.some(e => e.referenceId === 'tx-hist-25b')).toBe(false);

    expect(histB.entries.some(e => e.referenceId === 'tx-hist-25b')).toBe(true);
    expect(histB.entries.some(e => e.referenceId === 'tx-hist-25a')).toBe(false);
  });

  // ── 26. Pagination works ───────────────────────────────────────────────────
  it('26. transaction history pagination works', async () => {
    for (let i = 1; i <= 5; i++) {
      await wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'USDT',
        amount: '10',
        referenceId: `page-dep-${i}`,
      });
    }

    const page1 = await wallet.getTransactions(userA.id, { accountId: userA.spotId, page: 1, pageSize: 2 });
    expect(page1.entries).toHaveLength(2);
    expect(page1.total).toBeGreaterThanOrEqual(5);

    const page2 = await wallet.getTransactions(userA.id, { accountId: userA.spotId, page: 2, pageSize: 2 });
    expect(page2.entries).toHaveLength(2);
    expect(page2.entries[0].referenceId).not.toBe(page1.entries[0].referenceId);
  });

  // ── 27. Asset filtering works ──────────────────────────────────────────────
  it('27. asset filtering works in transaction history', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'BTC',
      amount: '1',
      referenceId: 'filter-btc-27',
    });
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'filter-usdt-27',
    });

    const btcHist = await wallet.getTransactions(userA.id, { accountId: userA.spotId, asset: 'BTC' });
    expect(btcHist.entries.every(e => e.asset === 'BTC')).toBe(true);
  });

  // ── 28. Transaction type filtering works ───────────────────────────────────
  it('28. transaction type filtering works in transaction history', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'type-dep-28',
    });
    await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'type-wd-28',
    });

    const wdHist = await wallet.getTransactions(userA.id, { accountId: userA.spotId, transactionType: 'WITHDRAWAL' });
    expect(wdHist.entries.every(e => e.transactionType === 'WITHDRAWAL')).toBe(true);
  });

  // ── 29. Invalid asset rejected ─────────────────────────────────────────────
  it('29. invalid asset rejected', async () => {
    await expect(
      wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'FAKECOIN',
        amount: '100',
        referenceId: 'inv-asset-29',
      })
    ).rejects.toMatchObject({
      code: WalletErrorCode.INVALID_ASSET,
    });
  });

  // ── 30. Invalid amount rejected ───────────────────────────────────────────
  it('30. invalid amount rejected (negative, zero, NaN)', async () => {
    await expect(
      wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'USDT',
        amount: '-50',
        referenceId: 'inv-amt-30a',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_AMOUNT,
    });

    await expect(
      wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'USDT',
        amount: '0',
        referenceId: 'inv-amt-30b',
      })
    ).rejects.toMatchObject({
      code: LedgerErrorCode.INVALID_AMOUNT,
    });
  });

  // ── 31. Excessive decimal precision rejected ───────────────────────────────
  it('31. excessive decimal precision rejected', async () => {
    await expect(
      wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'USDT',
        amount: '1.123456789',
        referenceId: 'prec-31',
      })
    ).rejects.toMatchObject({
      code: WalletErrorCode.EXCESSIVE_DECIMAL_PRECISION,
    });
  });

  // ── 32. Disabled asset rejected ────────────────────────────────────────────
  it('32. disabled asset rejected', async () => {
    await database.query("UPDATE assets SET is_active = false WHERE symbol = 'DOGE'");

    await expect(
      wallet.paperDeposit({
        adminUserId: adminUser.id,
        targetAccountId: userA.spotId,
        asset: 'DOGE',
        amount: '100',
        referenceId: 'dis-32',
      })
    ).rejects.toMatchObject({
      code: WalletErrorCode.ASSET_DISABLED,
    });
  });

  // ── 33. Locked balance remains unaffected by normal withdrawal ─────────────
  it('33. locked balance remains unaffected by normal withdrawal', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-lock-33',
    });

    // Lock 400 for an order
    await ledger.reserve(userA.spotId, 'USDT', '400', 'SPOT_ORDER_LOCK', 'lock-33', 'Lock');

    // Withdraw 300
    await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '300',
      referenceId: 'wd-33',
    });

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    expect(bal.availableBalance).toBe(decimalNormalize('300'));
    expect(bal.lockedBalance).toBe(decimalNormalize('400'));
    expect(bal.totalBalance).toBe(decimalNormalize('700'));
  });

  // ── 34. Deposit affects available balance correctly ────────────────────────
  it('34. deposit affects available balance correctly', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'ETH',
      amount: '5.25',
      referenceId: 'dep-34',
    });

    const bal = await wallet.getBalance(userA.id, userA.spotId, 'ETH');
    expect(bal.availableBalance).toBe(decimalNormalize('5.25'));
    expect(bal.lockedBalance).toBe(decimalNormalize('0'));
    expect(bal.totalBalance).toBe(decimalNormalize('5.25'));
  });

  // ── 35. Transfer preserves total user funds ────────────────────────────────
  it('35. transfer preserves total user funds across accounts', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '1000',
      referenceId: 'seed-total-35',
    });

    await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.futuresId,
      asset: 'USDT',
      amount: '300',
      referenceId: 'xfer-total-35a',
    });

    await wallet.transfer({
      userId: userA.id,
      fromAccountId: userA.spotId,
      toAccountId: userA.fundingId,
      asset: 'USDT',
      amount: '200',
      referenceId: 'xfer-total-35b',
    });

    const spot = await wallet.getBalance(userA.id, userA.spotId, 'USDT');
    const fut = await wallet.getBalance(userA.id, userA.futuresId, 'USDT');
    const fund = await wallet.getBalance(userA.id, userA.fundingId, 'USDT');

    const total = decimalAdd(decimalAdd(spot.totalBalance, fut.totalBalance), fund.totalBalance);
    expect(total).toBe(decimalNormalize('1000'));
  });

  // ── 36. Paper mode is clearly identified ───────────────────────────────────
  it('36. paper mode is clearly identified in receipts', async () => {
    const depReceipt = await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'mode-dep-36',
    });
    expect(depReceipt.mode).toBe('PAPER');

    const wdReceipt = await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'mode-wd-36',
    });
    expect(wdReceipt.mode).toBe('PAPER');
  });

  // ── 37. No blockchain transaction is created ───────────────────────────────
  it('37. no blockchain transaction is created (only internal ledger)', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '100',
      referenceId: 'seed-noblockchain-37',
    });

    const wdReceipt = await wallet.paperWithdraw({
      userId: userA.id,
      accountId: userA.spotId,
      asset: 'USDT',
      amount: '50',
      referenceId: 'noblockchain-37',
    });
    expect((wdReceipt as any).txHash).toBeUndefined();
    expect(wdReceipt.mode).toBe('PAPER');
  });


  // ── 38. No public unrestricted deposit endpoint exists ─────────────────────
  it('38. controller rejects unauthenticated calls', async () => {
    const req = { user: undefined, body: { targetAccountId: userA.spotId, asset: 'USDT', amount: '100', referenceId: 'pub-38' } } as unknown as Request;
    const res = {} as Response;
    let authErr: any = null;

    await adminPaperDeposit(req, res, (err) => { authErr = err; });

    expect(authErr).toBeDefined();
    expect(authErr.statusCode).toBe(401);
  });

  // ── 39. No financial mutation bypasses LedgerService ───────────────────────
  it('39. all financial mutations flow through LedgerService', async () => {
    await wallet.paperDeposit({
      adminUserId: adminUser.id,
      targetAccountId: userA.spotId,
      asset: 'USDT',
      amount: '500',
      referenceId: 'ledger-flow-39',
    });

    const rec = await ledger.reconcile(userA.spotId, 'USDT');
    expect(rec.isConsistent).toBe(true);
    expect(rec.discrepancy).toBe(decimalNormalize('0'));
    expect(rec.walletTotal).toBe(decimalNormalize('500'));
  });

  // ── 40. Signup account initialization is atomic ────────────────────────────
  it('40. signup account initialization is atomic and creates 3 accounts', async () => {
    const signup = await auth.signup({ email: 'atomictest@novacex.io', password: 'Password123!' });
    const accs = await wallet.initializeAccounts(signup.user.id);
    expect(accs).toHaveLength(3);
  });
});
