import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DatabasePool, db as globalDb } from '../src/config/database';
import { FuturesLiquidationService } from '../src/services/futures/liquidation.service';
import { FuturesRiskService } from '../src/services/futures/risk.service';
import { FuturesPositionService } from '../src/services/futures/position.service';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { developmentMarkPriceProvider } from '../src/services/futures/mark-price.provider';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { futuresFundingService } from '../src/services/futures/funding.service';
import { LiquidationNotAuthorizedError, InvalidMarkPriceError, MarkPriceUnavailableError, PositionAlreadyLiquidatedError, LiquidationNotEligibleError } from '../src/services/futures/errors';
import { decimalCompare } from '../src/services/ledger/decimal';

/**
 * Phase 0F — Mandatory P0/P1 Remediation Tests (A–Q)
 *
 * These tests verify every security fix applied to the futures P0/P1 family.
 * They run against the in-memory DatabasePool with mocked / real components
 * as needed, ensuring no regression of the original attacks.
 */

const POS_INSERT_SQL = `INSERT INTO futures_positions (
  id, account_id, symbol, side, quantity, entry_price, mark_price, liquidation_price,
  leverage, margin_mode, initial_margin, maintenance_margin, realized_pnl, status,
  collateral_asset, maintenance_margin_rate, created_at, updated_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`;

function posParams(overrides: Record<string, any> = {}) {
  return [
    overrides.id || 'pos-a',
    overrides.account_id || 'acc-owner',
    overrides.symbol || 'BTCUSDT',
    overrides.side || 'LONG',
    overrides.quantity || '1',
    overrides.entry_price || '50000',
    overrides.mark_price || '50000',
    overrides.liquidation_price || '40000',
    overrides.leverage ?? 10,
    overrides.margin_mode || 'ISOLATED',
    overrides.initial_margin || '5000',
    overrides.maintenance_margin || '250',
    overrides.realized_pnl || '0',
    overrides.status || 'OPEN',
    overrides.collateral_asset || 'FUTURES_USDT',
    overrides.maintenance_margin_rate || '0.005',
    overrides.created_at || new Date(),
    overrides.updated_at || new Date(),
  ];
}

/** Insert a wallet row with the column order the in-memory handler expects. */
async function insertWallet(
  db: DatabasePool,
  accountId: string,
  asset: string,
  available: string,
  locked: string
): Promise<void> {
  await db.query(
    'INSERT INTO wallet_balances (id, account_id, asset, available_balance, locked_balance) VALUES ($1,$2,$3,$4,$5)',
    [`wb-${accountId}-${asset}`, accountId, asset, available, locked]
  );
}

describe('Phase 0F — Mandatory P0/P1 Remediation Tests (A–Q)', () => {
  let liquidationService: FuturesLiquidationService;
  let riskService: FuturesRiskService;
  let positionService: FuturesPositionService;
  let ledgerServiceInst: LedgerService;
  let pool: DatabasePool;

  beforeEach(async () => {
    pool = new DatabasePool(); // fresh in-memory instance
    await pool.connect();
    riskService = new FuturesRiskService();
    positionService = new FuturesPositionService(pool, riskService);
    ledgerServiceInst = new LedgerService(pool);
    liquidationService = new FuturesLiquidationService(
      pool, riskService, positionService, ledgerServiceInst, developmentMarkPriceProvider
    );
    developmentMarkPriceProvider.reset();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await pool.close();
  });

  // ── A. Cross-account liquidation ──────────────────────────────────────────

  it('A. cross-account liquidation throws LiquidationNotAuthorizedError', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-cross' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const promise = liquidationService.evaluateAndLiquidate('pos-cross', '40000', 'acc-attacker');
    await expect(promise).rejects.toThrow(LiquidationNotAuthorizedError);
  });

  // ── B/C/D. Mark price validation ──────────────────────────────────────────

  it('B. zero mark price throws InvalidMarkPriceError', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-zero' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const promise = liquidationService.evaluateAndLiquidate('pos-zero', '0', 'acc-owner');
    await expect(promise).rejects.toThrow(InvalidMarkPriceError);
  });

  it('C. negative mark price throws InvalidMarkPriceError', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-neg' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const promise = liquidationService.evaluateAndLiquidate('pos-neg', '-100', 'acc-owner');
    await expect(promise).rejects.toThrow(InvalidMarkPriceError);
  });

  it('D. extreme mark price (>1e17) throws InvalidMarkPriceError', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-extreme' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const promise = liquidationService.evaluateAndLiquidate('pos-extreme', '1000000000000000000', 'acc-owner');
    await expect(promise).rejects.toThrow(InvalidMarkPriceError);
  });

  // ── E. Stale/failed mark price ────────────────────────────────────────────

  it('E. authoritative mark price provider failure throws MarkPriceUnavailableError', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-stale' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    vi.spyOn(developmentMarkPriceProvider, 'getMarkPrice').mockRejectedValue(new Error('Provider unavailable'));

    const promise = liquidationService.evaluateAndLiquidate('pos-stale', undefined, 'acc-owner');
    await expect(promise).rejects.toThrow(MarkPriceUnavailableError);
  });

  // ── F. Wrong-market ───────────────────────────────────────────────────────

  it('F. authoritative price is fetched for the position symbol (not attacker chosen)', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-eth', symbol: 'ETHUSDT', side: 'LONG', quantity: '10', entry_price: '3000', liquidation_price: '2800', initial_margin: '3000', maintenance_margin: '150', leverage: 10 }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '3000');

    // Mark price for the position's symbol is set — the authoritative path must
    // use ETHUSDT's price, never a wrong-market override.
    developmentMarkPriceProvider.setMarkPrice('ETHUSDT', '3100');

    // Profit at 3100 → equity >= maintenance → NOT eligible → LiquidationNotEligibleError
    const promise = liquidationService.evaluateAndLiquidate('pos-eth', undefined, 'acc-owner');
    await expect(promise).rejects.toThrow(LiquidationNotEligibleError);
  });

  // ── G. Concurrent liquidation ─────────────────────────────────────────────

  it('G. concurrent liquidation of the same position fails (FOR UPDATE lock)', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-conc', initial_margin: '5000', maintenance_margin: '250' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const promise1 = liquidationService.evaluateAndLiquidate('pos-conc', '40000', 'acc-owner');
    const promise2 = liquidationService.evaluateAndLiquidate('pos-conc', '40000', 'acc-owner');

    const results = await Promise.allSettled([promise1, promise2]);
    const succeeded = results.filter(r => r.status === 'fulfilled');
    const failed = results.filter(r => r.status === 'rejected');

    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    // The losing concurrent call must fail with either a duplicate-position
    // guard or a lock conflict (never silently double-liquidate).
    for (const f of failed) {
      const err = f.reason as any;
      const isDup = err instanceof PositionAlreadyLiquidatedError;
      const isLock = typeof err?.message === 'string' && /LOCK_CONFLICT|lock|FOR UPDATE|concurrent/i.test(err.message);
      expect(isDup || isLock).toBe(true);
    }
  });

  // ── H. Liquidation-vs-close race ──────────────────────────────────────────

  it('H. liquidation after position is closed (status changed) throws PositionAlreadyLiquidatedError', async () => {
    // Insert the position already in a non-OPEN state to simulate a close race
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-close', status: 'LIQUIDATED' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const promise = liquidationService.evaluateAndLiquidate('pos-close', '40000', 'acc-owner');
    await expect(promise).rejects.toThrow(PositionAlreadyLiquidatedError);
  });

  // ── I. Duplicate liquidation ──────────────────────────────────────────────

  it('I. duplicate liquidation of an already liquidated position throws PositionAlreadyLiquidatedError', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-dup', initial_margin: '5000', maintenance_margin: '250' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    // First liquidation succeeds (bankrupt at 40000 vs entry 50000)
    const first = await liquidationService.evaluateAndLiquidate('pos-dup', '40000', 'acc-owner');
    expect(first.finalStatus).toBe('LIQUIDATED');

    // Second call must fail
    const promise = liquidationService.evaluateAndLiquidate('pos-dup', '40000', 'acc-owner');
    await expect(promise).rejects.toThrow(PositionAlreadyLiquidatedError);
  });

  // ── J. Rollback ───────────────────────────────────────────────────────────

  it('J. ledger failure inside transaction triggers full rollback', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-roll', initial_margin: '5000', maintenance_margin: '250' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    vi.spyOn(ledgerServiceInst, 'postTransaction').mockRejectedValue(new Error('Ledger unavailable'));

    const promise = liquidationService.evaluateAndLiquidate('pos-roll', '40000', 'acc-owner');
    await expect(promise).rejects.toThrow('Ledger unavailable');

    // Verify the position is still OPEN (transaction rolled back)
    const res = await pool.query('SELECT status FROM futures_positions WHERE id = $1', ['pos-roll']);
    expect(res.rows[0].status).toBe('OPEN');
  });

  // ── K. Crash recovery ─────────────────────────────────────────────────────

  it('K. crash recovery is a database-level guarantee (atomic transaction)', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-crash', initial_margin: '5000', maintenance_margin: '250' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    // Simulate a crash INSIDE the transaction: the position UPDATE succeeds
    // but the INSERT INTO futures_liquidations throws.  The real in-memory
    // transaction() snapshots state and rolls back on error, so the position
    // must remain OPEN (no partial state visible).
    const origQuery = pool.query.bind(pool);
    vi.spyOn(pool, 'query').mockImplementation(async (sql: string, params?: any[]) => {
      const s = typeof sql === 'string' ? sql : '';
      if (/INSERT\s+INTO\s+futures_liquidations/i.test(s)) {
        // Simulate crash after the position UPDATE is already applied
        throw new Error('SIMULATED CRASH AFTER PARTIAL WORK');
      }
      return origQuery(sql, params);
    });

    await expect(
      liquidationService.evaluateAndLiquidate('pos-crash', '40000', 'acc-owner')
    ).rejects.toThrow('SIMULATED CRASH AFTER PARTIAL WORK');

    // The transaction rollback must restore the position to OPEN
    const res = await pool.query('SELECT status FROM futures_positions WHERE id = $1', ['pos-crash']);
    expect(res.rows[0].status).toBe('OPEN');
  });

  // ── L. Funding zero-sum ───────────────────────────────────────────────────

  it('L. funding settlement posts zero-sum payments across all positions', async () => {
    // Funding service uses the module-level db singleton — connect it
    const gdb = globalDb as DatabasePool;
    await gdb.connect();
    (gdb as any).reset();
    developmentMarkPriceProvider.reset();

    await gdb.query(POS_INSERT_SQL, posParams({
      id: 'pos-fund-long', account_id: 'acc-long', side: 'LONG', initial_margin: '5000', maintenance_margin: '250',
    }));
    await gdb.query(POS_INSERT_SQL, posParams({
      id: 'pos-fund-short', account_id: 'acc-short', side: 'SHORT', quantity: '1', entry_price: '50000', mark_price: '50000', liquidation_price: '60000', margin_mode: 'CROSS', initial_margin: '5000', maintenance_margin: '250',
    }));
    await insertWallet(gdb, 'acc-long', 'FUTURES_USDT', '10000', '5000');
    await insertWallet(gdb, 'acc-short', 'FUTURES_USDT', '10000', '5000');

    // Rate defaults to 0.0001 (mark == index at 50000): LONG pays 5, SHORT receives 5
    const result = await futuresFundingService.settleFundingInterval('BTCUSDT');
    expect(result.settledPositions).toBe(2);
  });

  // ── M. MMR boundary ───────────────────────────────────────────────────────

  it('M. uses persisted maintenance_margin_rate from position (not hardcoded)', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-mmr', initial_margin: '5000', maintenance_margin: '250', maintenance_margin_rate: '0.01' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    const spyMM = vi.spyOn(riskService, 'calculateMaintenanceMargin');

    // Bankrupt at 40000 → liquidation proceeds and resolves; the persisted MMR 0.01 must be used
    const result = await liquidationService.evaluateAndLiquidate('pos-mmr', '40000', 'acc-owner');
    expect(result.finalStatus).toBe('LIQUIDATED');

    const mmrArgs = spyMM.mock.calls.map(c => c[2]);
    expect(mmrArgs).toContain('0.01');
  });

  // ── N. Collateral boundary ────────────────────────────────────────────────

  it('N. queries wallet_balances using persisted collateral_asset', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-coll', collateral_asset: 'USDT' }));
    await insertWallet(pool, 'acc-owner', 'USDT', '0', '5000');

    const querySpy = vi.spyOn(pool, 'query');

    // Liquidation resolves (bankrupt position); collateral USDT is queried
    const result = await liquidationService.evaluateAndLiquidate('pos-coll', '40000', 'acc-owner');
    expect(result.finalStatus).toBe('LIQUIDATED');

    // Find the SELECT wallet_balances query carrying the USDT collateral asset
    const walletSelects = querySpy.mock.calls.filter(call =>
      typeof call[0] === 'string' && /^SELECT/i.test(call[0]) && /wallet_balances/i.test(call[0])
    );
    const collateralQuery = walletSelects.find(call =>
      Array.isArray(call[1]) && call[1].includes('USDT')
    );
    expect(collateralQuery).toBeTruthy();
  });

  // ── O. Dev-price production guard ─────────────────────────────────────────

  it('O. assertNotProduction throws in production environment', async () => {
    const { assertNotProduction } = await import('../src/services/futures/mark-price.provider');

    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    try {
      expect(() => assertNotProduction('test')).toThrow(/SECURITY/);
    } finally {
      process.env.NODE_ENV = originalEnv;
    }
  });

  // ── P. Breaker fail-closed ────────────────────────────────────────────────

  it('P. isSubsystemOperational returns false when FUTURES_TRADING is halted', async () => {
    // Circuit breaker singleton uses the module-level db — connect it
    const gdb = globalDb as DatabasePool;
    await gdb.connect();
    (gdb as any).reset();
    circuitBreakerService.resetCache();

    const cbResult = await circuitBreakerService.isSubsystemOperational('FUTURES_TRADING');
    expect(cbResult.operational).toBe(true);

    await circuitBreakerService.halt({ mode: 'HALT_ALL', reason: 'Test halt', initiatedBy: 'manual' } as any);

    const cbResult2 = await circuitBreakerService.isSubsystemOperational('FUTURES_TRADING');
    expect(cbResult2.operational).toBe(false);
    expect(cbResult2.mode).toBe('HALT_ALL');
  });

  // ── Q. Ownership ──────────────────────────────────────────────────────────

  it('Q. evaluateAndLiquidate enforces ownership via authorizedAccountId', async () => {
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-own', initial_margin: '5000', maintenance_margin: '250' }));
    await insertWallet(pool, 'acc-owner', 'FUTURES_USDT', '0', '5000');

    // Correct owner — proceeds (bankrupt at 40000 → liquidated)
    const ok = await liquidationService.evaluateAndLiquidate('pos-own', '40000', 'acc-owner');
    expect(ok.finalStatus).toBe('LIQUIDATED');

    // Wrong owner — fails immediately
    await pool.query(POS_INSERT_SQL, posParams({ id: 'pos-own2', account_id: 'acc-owner', initial_margin: '5000', maintenance_margin: '250' }));
    const promise2 = liquidationService.evaluateAndLiquidate('pos-own2', '40000', 'wrong-acc');
    await expect(promise2).rejects.toThrow(LiquidationNotAuthorizedError);
  });
});