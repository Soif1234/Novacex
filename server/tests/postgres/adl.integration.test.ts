import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { FuturesLiquidationService } from '../../src/services/futures/liquidation.service';
import { FuturesPositionService } from '../../src/services/futures/position.service';
import { FuturesAdlService, ADL_SUSPENSE_ACCOUNT_ID } from '../../src/services/futures/adl.service';
import { INSURANCE_FUND_ACCOUNT_ID } from '../../src/services/futures/insurance-fund.service';
import { futuresRiskService } from '../../src/services/futures/risk.service';
import { decimalCompare } from '../../src/services/ledger/decimal';
import crypto from 'crypto';

/**
 * Phase 6.4B — Auto-Deleveraging (ADL) Integration Tests
 *
 * These tests run against a real PostgreSQL instance and exercise the full
 * Liquidation → Insurance Fund → ADL Suspense → ADL Execution pipeline.
 */
describe('Phase 6.4B Auto-Deleveraging (ADL) Integration', () => {
  let db: PostgresDatabasePool;
  let ledger: LedgerService;
  let liquidationService: FuturesLiquidationService;
  let adlService: FuturesAdlService;

  // ── Setup / Teardown ────────────────────────────────────────────────────

  beforeAll(async () => {
    db = new PostgresDatabasePool();
    await db.connect();
    const migrator = new SchemaMigrator(undefined, db);
    await migrator.runMigrations();

    ledger = new LedgerService(db);
    const positionService = new FuturesPositionService(db, futuresRiskService);
    liquidationService = new FuturesLiquidationService(
      db, futuresRiskService, positionService, ledger
    );
    adlService = new FuturesAdlService(db, ledger, futuresRiskService);
  });

  afterAll(async () => {
    await db.close();
  });

  // ── Test helpers ────────────────────────────────────────────────────────

  /** Create a test user, FUTURES account, and deposit funds. Returns accountId. */
  async function createFundedAccount(deposit: string): Promise<string> {
    const userId = crypto.randomUUID();
    const email = `adl-test-${userId.slice(0, 8)}@test.com`;
    await db.query(
      'INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [userId, email]
    );
    const accRes = await db.query<any>(
      `INSERT INTO accounts (user_id, type) VALUES ($1, 'FUTURES')
       ON CONFLICT (user_id, type) DO UPDATE SET updated_at = NOW()
       RETURNING id`,
      [userId]
    );
    const accountId = accRes.rows[0].id;

    // Deterministic reference using the account id
    await ledger.credit(
      accountId, 'FUTURES_USDT', deposit, 'DEPOSIT' as any,
      `SETUP-DEP-${accountId}`, 'Test setup deposit'
    );
    return accountId;
  }

  /** Open a futures position. Returns positionId. */
  async function openPosition(
    accountId: string, side: string, quantity: string,
    price: string, leverage: number
  ): Promise<string> {
    const im = futuresRiskService.calculateInitialMargin(quantity, price, leverage);
    const mm = futuresRiskService.calculateMaintenanceMargin(quantity, price, '0.005');
    const lp = futuresRiskService.calculateLiquidationPrice(
      { marginMode: 'CROSS', side: side as any, entryPrice: price,
        quantity, initialMargin: im, maintenanceMargin: mm },
      '0.005', '0'
    );

    // Lock IM
    const posId = crypto.randomUUID();
    await ledger.postTransaction({
      accountId,
      transactionType: 'FUTURES_MARGIN_LOCK' as any,
      referenceId: `LOCK-${posId}`,
      description: 'Lock IM for position',
      entries: [
        { accountId, asset: 'FUTURES_USDT', direction: 'DEBIT', amount: im, balancePool: 'available' },
        { accountId, asset: 'FUTURES_USDT', direction: 'CREDIT', amount: im, balancePool: 'locked' },
      ],
    });

    await db.query(
      `INSERT INTO futures_positions
        (id, account_id, symbol, side, margin_mode, leverage,
         quantity, entry_price, mark_price, initial_margin,
         maintenance_margin, liquidation_price, status)
       VALUES ($1, $2, $3, $4, 'CROSS', $5, $6, $7, $7, $8, $9, $10, 'OPEN')`,
      [posId, accountId, 'BTCUSDT', side, leverage, quantity, price, im, mm, lp]
    );
    return posId;
  }

  /** Ensure system bot user and system accounts exist. */
  async function ensureSystemAccounts(): Promise<void> {
    // Ensure SYSTEM_BOT user
    await db.query(
      `INSERT INTO users (id, email, role, account_status)
       VALUES ('00000000-0000-0000-0000-000000000000', 'system.bot@novacex.io', 'SYSTEM_BOT', 'ACTIVE')
       ON CONFLICT DO NOTHING`
    );
    // Ensure Insurance Fund account
    await db.query(
      `INSERT INTO accounts (id, user_id, type)
       VALUES ($1, '00000000-0000-0000-0000-000000000000', 'SYSTEM_VAULT')
       ON CONFLICT (user_id, type) DO UPDATE SET id = EXCLUDED.id`,
      [INSURANCE_FUND_ACCOUNT_ID]
    );
    // Ensure ADL Suspense account
    await db.query(
      `INSERT INTO accounts (id, user_id, type)
       VALUES ($1, '00000000-0000-0000-0000-000000000000', 'SYSTEM_ADL_SUSPENSE')
       ON CONFLICT (user_id, type) DO UPDATE SET id = EXCLUDED.id`,
      [ADL_SUSPENSE_ACCOUNT_ID]
    );
  }

  /** Seed (or reset) the Insurance Fund to a specific balance. */
  async function seedInsuranceFund(amount: string): Promise<void> {
    await ensureSystemAccounts();
    await db.query(
      `INSERT INTO wallet_balances (account_id, asset, available_balance, locked_balance)
       VALUES ($1, 'FUTURES_USDT', $2, 0)
       ON CONFLICT (account_id, asset)
       DO UPDATE SET available_balance = $2`,
      [INSURANCE_FUND_ACCOUNT_ID, amount]
    );
  }

  /** Reset the ADL suspense account to zero. */
  async function resetSuspenseBalance(): Promise<void> {
    await ensureSystemAccounts();
    await db.query(
      `INSERT INTO wallet_balances (account_id, asset, available_balance, locked_balance)
       VALUES ($1, 'FUTURES_USDT', '0', '0')
       ON CONFLICT (account_id, asset)
       DO UPDATE SET available_balance = '0'`,
      [ADL_SUSPENSE_ACCOUNT_ID]
    );
  }

  /** Get current suspense balance. */
  async function getSuspenseBalance(): Promise<string> {
    const res = await db.query<any>(
      'SELECT available_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [ADL_SUSPENSE_ACCOUNT_ID, 'FUTURES_USDT']
    );
    return res.rows[0]?.available_balance ?? '0';
  }

  /** Get wallet balances (available + locked) for an account. */
  async function getWalletBalance(accountId: string): Promise<{ available: string; locked: string }> {
    const res = await db.query<any>(
      'SELECT available_balance, locked_balance FROM wallet_balances WHERE account_id = $1 AND asset = $2',
      [accountId, 'FUTURES_USDT']
    );
    return {
      available: res.rows[0]?.available_balance ?? '0',
      locked: res.rows[0]?.locked_balance ?? '0',
    };
  }

  // ── Tests ───────────────────────────────────────────────────────────────

  it('1. Insurance Fund covers full deficit → no ADL event created', async () => {
    const acc = await createFundedAccount('1000');
    const posId = await openPosition(acc, 'LONG', '1', '50000', 50);

    await resetSuspenseBalance();
    await seedInsuranceFund('5000');

    // Mark drops to 48000 → loss = 2000, IM = 1000
    // User's margin is exhausted but Insurance Fund covers the remaining deficit
    await liquidationService.evaluateAndLiquidate(posId, '48000');

    // No ADL event should have been created
    const events = await db.query<any>(
      `SELECT * FROM futures_adl_events
       WHERE liquidation_id = (
         SELECT id FROM futures_liquidations
         WHERE position_id = $1
         ORDER BY created_at DESC LIMIT 1
       )`,
      [posId]
    );
    expect(events.rows.length).toBe(0);
  });

  it('2. Insurance Fund exhausted → ADL event created with correct deficit', async () => {
    const acc = await createFundedAccount('1000');
    const posId = await openPosition(acc, 'LONG', '1', '50000', 50);

    await resetSuspenseBalance();
    await seedInsuranceFund('200'); // Small IF — won't cover full deficit

    const liq = await liquidationService.evaluateAndLiquidate(posId, '48000');

    // ADL event should exist
    const events = await db.query<any>(
      'SELECT * FROM futures_adl_events WHERE liquidation_id = $1',
      [liq.liquidation.id]
    );
    expect(events.rows.length).toBe(1);
    expect(events.rows[0].status).toBe('PENDING');

    const targetDeficit = String(events.rows[0].target_deficit);
    expect(decimalCompare(targetDeficit, '0')).toBeGreaterThan(0);

    // Suspense should be negative (deficit booked)
    const suspenseBal = await getSuspenseBalance();
    expect(decimalCompare(suspenseBal, '0')).toBeLessThan(0);
  });

  it('3. ADL processes counterparties by ROE ranking and recovers deficit', async () => {
    // ── Setup counterparties ──────────────────────────────────────────
    // CP1: SHORT 1 BTC @ 50000, Leverage 10 → IM = 5000, ROE lower
    const accCp1 = await createFundedAccount('6000');
    const cp1PosId = await openPosition(accCp1, 'SHORT', '1', '50000', 10);

    // CP2: SHORT 1 BTC @ 50000, Leverage 50 → IM = 1000, ROE higher
    const accCp2 = await createFundedAccount('2000');
    const cp2PosId = await openPosition(accCp2, 'SHORT', '1', '50000', 50);

    // ── Setup bankrupt position ───────────────────────────────────────
    const accBankrupt = await createFundedAccount('1000');
    const bankruptPosId = await openPosition(accBankrupt, 'LONG', '1', '50000', 50);

    await resetSuspenseBalance();
    await seedInsuranceFund('0'); // Force full deficit to ADL

    // ── Liquidate ─────────────────────────────────────────────────────
    const liq = await liquidationService.evaluateAndLiquidate(bankruptPosId, '48000');

    const events = await db.query<any>(
      'SELECT * FROM futures_adl_events WHERE liquidation_id = $1',
      [liq.liquidation.id]
    );
    expect(events.rows.length).toBe(1);
    const eventId = events.rows[0].id;

    // ── Execute ADL (first pass) ──────────────────────────────────────
    // Both shorts are profitable at mark=48000 (SHORT entered at 50000,
    // profit = 2000 per BTC). CP2 has higher ROE (leverage 50).
    // The ADL should target CP2 first.
    await adlService.processAdlEvent(eventId, '48000');

    // Check CP2 was selected (higher ROE)
    const cp2After = await db.query<any>(
      'SELECT quantity, status FROM futures_positions WHERE id = $1',
      [cp2PosId]
    );
    // CP2 should have been reduced (partially or fully)
    expect(decimalCompare(String(cp2After.rows[0].quantity), '1')).toBeLessThan(0);

    // Check ADL event status
    let evtAfter = await db.query<any>(
      'SELECT status, resolved_deficit FROM futures_adl_events WHERE id = $1',
      [eventId]
    );

    // If not fully settled after CP2, process again for CP1
    if (evtAfter.rows[0].status !== 'SETTLED') {
      await adlService.processAdlEvent(eventId, '48000');
      evtAfter = await db.query<any>(
        'SELECT status, resolved_deficit FROM futures_adl_events WHERE id = $1',
        [eventId]
      );
    }

    expect(evtAfter.rows[0].status).toBe('SETTLED');

    // Suspense should have been recovered to zero (or positive)
    const suspenseBal = await getSuspenseBalance();
    expect(decimalCompare(suspenseBal, '0')).toBeGreaterThanOrEqual(0);

    // ── Accounting validation ────────────────────────────────────────────
    // With the fee excluded from the liquidation deficit (uncovered trading
    // loss = 1,000), CP2's full close at the bankruptcy price recovers the
    // entire deficit: CP2 receives released IM (1,000) + realized profit
    // (1,000), the suspense returns to zero, and the Insurance Fund, which
    // funded both credits, returns to zero. CP1 is never touched.
    const cp2Bal = await getWalletBalance(accCp2);
    expect(cp2Bal.available).toBe('3000');
    expect(cp2Bal.locked).toBe('0');

    const cp1Bal = await getWalletBalance(accCp1);
    expect(cp1Bal.available).toBe('1000');
    expect(cp1Bal.locked).toBe('5000');

    const bankruptBal = await getWalletBalance(accBankrupt);
    expect(bankruptBal.available).toBe('0');
    expect(bankruptBal.locked).toBe('0');

    const ifBal = await getWalletBalance(INSURANCE_FUND_ACCOUNT_ID);
    expect(ifBal.available).toBe('0');
    expect(ifBal.locked).toBe('0');

    expect(decimalCompare(suspenseBal, '0')).toBe(0);

    // System total across the five fixture accounts is conserved (9,000).
    const totalRes = await db.query<any>(
      `SELECT COALESCE(SUM(available_balance + locked_balance), 0) AS total
       FROM wallet_balances
       WHERE asset = 'FUTURES_USDT'
         AND account_id = ANY($1)`,
      [[accCp1, accCp2, accBankrupt, INSURANCE_FUND_ACCOUNT_ID, ADL_SUSPENSE_ACCOUNT_ID]]
    );
    expect(String(totalRes.rows[0].total)).toBe('9000');
  });

  it('4. UNRESOLVED when no profitable counterparties exist', async () => {
    const accBankrupt = await createFundedAccount('1000');
    const bankruptPosId = await openPosition(accBankrupt, 'LONG', '1', '50000', 50);

    await resetSuspenseBalance();
    await seedInsuranceFund('0');

    // Close all SHORT positions so ADL has no candidates
    await db.query(`UPDATE futures_positions SET status = 'CLOSED' WHERE side = 'SHORT'`);

    const liq = await liquidationService.evaluateAndLiquidate(bankruptPosId, '48000');

    const events = await db.query<any>(
      'SELECT * FROM futures_adl_events WHERE liquidation_id = $1',
      [liq.liquidation.id]
    );
    expect(events.rows.length).toBe(1);
    const eventId = events.rows[0].id;

    // Process ADL — no candidates should result in UNRESOLVED
    await adlService.processAdlEvent(eventId, '48000');

    const evtAfter = await db.query<any>(
      'SELECT status FROM futures_adl_events WHERE id = $1',
      [eventId]
    );
    expect(evtAfter.rows[0].status).toBe('UNRESOLVED');
  });
});
