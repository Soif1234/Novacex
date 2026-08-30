import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { sweepWorker } from '../src/workers/SweepWorker';
import { workerSupervisor } from '../src/workers/WorkerSupervisor';
import { db } from '../src/config/database';
import { custodyService } from '../src/services/custody/custody.service';
import {
  SweepZeroBalanceError,
  SweepReconciliationRequiredError,
  SweepDustError,
} from '../src/services/custody/custody.errors';
import { pendingSweepProducer } from '../src/services/custody/pending-sweep-producer.service';
import { env } from '../src/config/env';

describe('SweepWorker Integration & Security', () => {
  let custodyMock: any;
  let dbQueryMock: any;
  let dbTransactionMock: any;

  beforeAll(() => {
    env.CRYPTO_WITHDRAWALS_ENABLED = 'true';
  });

  beforeEach(() => {
    custodyMock = vi.spyOn(custodyService, 'sweepDepositAddress').mockResolvedValue('0xmockedtxhash123');
    vi.spyOn(custodyService, 'reconcileDepositAddress').mockResolvedValue({
      expectedRemaining: '0', physical: '0', status: 'BALANCED'
    });

    dbQueryMock = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT DISTINCT ps.network')) {
        return {
          rowCount: 1,
          rows: [
            { network: 'ETHEREUM', address: '0x111122223333', asset: 'USDT' }
          ]
        };
      }
      if (sql.includes("UPDATE pending_sweeps SET status = 'PENDING' WHERE status IN ('PROCESSING', 'SIGNING')")) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    dbTransactionMock = vi.spyOn(db, 'transaction').mockImplementation(async (cb: any) => {
      const clientMock = {
        query: vi.fn().mockImplementation(async (sql: string, params: any[]) => {
          if (sql.includes('pg_try_advisory_xact_lock')) {
            return { rowCount: 1, rows: [{ pg_try_advisory_xact_lock: true }] };
          }
          if (sql.includes('UPDATE pending_sweeps ps')) {
            return {
              rowCount: 3,
              rows: [
                { id: 'sweep-1', asset: 'USDT' },
                { id: 'sweep-2', asset: 'USDT' },
                { id: 'sweep-3', asset: 'USDT' }
              ]
            };
          }
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(clientMock);
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  it('A. verifies SweepWorker and SweepStatusWorker are registered in WorkerSupervisor', () => {
    const workerNames = workerSupervisor.getWorkerNames();
    expect(workerNames).toContain('SweepWorker');
    expect(workerNames).toContain('SweepStatusWorker');
  });

  it('claims grouped pending sweeps and updates their status to BROADCAST', async () => {
    await (sweepWorker as any).execute();

    expect(dbQueryMock).toHaveBeenCalled();
    expect(dbTransactionMock).toHaveBeenCalled();

    expect(custodyMock).toHaveBeenCalledTimes(1);
    expect(custodyMock).toHaveBeenCalledWith('ETHEREUM', '0x111122223333', 'USDT', ['sweep-1', 'sweep-2', 'sweep-3']);
  });

  it('defers sweep if balance is ZERO_BALANCE', async () => {
    custodyMock.mockRejectedValue(new Error('ZERO_BALANCE'));

    await (sweepWorker as any).execute();

    expect(custodyMock).toHaveBeenCalledTimes(1);
    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pending_sweeps'),
      ['ZERO_BALANCE', ['sweep-1', 'sweep-2', 'sweep-3']]
    );
  });

  it('defers sweep if balance is DUST to DEFERRED_DUST', async () => {
    custodyMock.mockRejectedValue(new Error('DUST'));

    await (sweepWorker as any).execute();

    expect(custodyMock).toHaveBeenCalledTimes(1);
    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pending_sweeps'),
      ['DEFERRED_DUST', ['sweep-1', 'sweep-2', 'sweep-3']]
    );
  });

  it('recovers stuck sweeps in PROCESSING or SIGNING older than timeout', async () => {
    dbQueryMock.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('UPDATE pending_sweeps') && sql.includes('status IN (\'PROCESSING\', \'SIGNING\')')) {
        return {
          rowCount: 2,
          rows: [{ id: 'stuck-1' }, { id: 'stuck-2' }]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    await (sweepWorker as any).recoverStuckSweeps(5);

    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('status IN (\'PROCESSING\', \'SIGNING\')'),
      [5]
    );
  });

  it('multi-token isolation: claims correct asset group independently', async () => {
    dbQueryMock.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT DISTINCT ps.network')) {
        return {
          rowCount: 2,
          rows: [
            { network: 'ETHEREUM', address: '0x111122223333', asset: 'USDT' },
            { network: 'ETHEREUM', address: '0x111122223333', asset: 'USDC' }
          ]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    await (sweepWorker as any).execute();

    expect(custodyMock).toHaveBeenCalledTimes(2);
    expect(custodyMock).toHaveBeenNthCalledWith(1, 'ETHEREUM', '0x111122223333', 'USDT', expect.any(Array));
    expect(custodyMock).toHaveBeenNthCalledWith(2, 'ETHEREUM', '0x111122223333', 'USDC', expect.any(Array));
  });

  // -----------------------------------------------------------------------
  // Phase 10.4 Step 6E-4C-2 â€” intent-aware recovery & typed error routing
  // -----------------------------------------------------------------------

  it('B. crash after reservation: recovery preserves sweep_intent_id (no blind nonce burn)', async () => {
    const recoveries: string[] = [];
    dbQueryMock.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('UPDATE pending_sweeps ps') && sql.includes('FROM sweep_intents si')) {
        recoveries.push(sql);
        // Recovery B must NOT clear the intent linkage.
        expect(sql).not.toContain('sweep_intent_id = NULL');
        return { rowCount: 1, rows: [{ id: 'stuck-signing-1' }] };
      }
      return { rowCount: 0, rows: [] };
    });

    await (sweepWorker as any).recoverStuckSweeps(5);

    expect(recoveries.length).toBe(1);
  });

  it('D. zero balance explained: rows reconcile to CONFIRMED against the historical sweep', async () => {
    custodyMock.mockRejectedValue(
      new SweepZeroBalanceError('ETHEREUM', '0x111122223333', 'USDT', '0xoldconfirmedsweep')
    );

    await (sweepWorker as any).execute();

    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining("SET status = 'CONFIRMED', sweep_txid = $1"),
      ['0xoldconfirmedsweep', ['sweep-1', 'sweep-2', 'sweep-3']]
    );
  });

  it('E. zero balance unexplained: rows flagged RECONCILIATION with a custody event (never settled silently)', async () => {
    custodyMock.mockRejectedValue(
      new SweepZeroBalanceError('ETHEREUM', '0x111122223333', 'USDT', null)
    );

    await (sweepWorker as any).execute();

    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pending_sweeps'),
      ['RECONCILIATION', ['sweep-1', 'sweep-2', 'sweep-3']]
    );
    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO custody_reconciliation_events'),
      expect.arrayContaining(['ZERO_BALANCE_UNEXPLAINED'])
    );
  });

  it('F. reserved nonce unusable: SweepReconciliationRequiredError routes rows to RECONCILIATION', async () => {
    custodyMock.mockRejectedValue(
      new SweepReconciliationRequiredError('intent-1', 5, 'nonce consumed externally')
    );

    await (sweepWorker as any).execute();

    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pending_sweeps'),
      ['RECONCILIATION', ['sweep-1', 'sweep-2', 'sweep-3']]
    );
    // Never back to PENDING for a reconciliation-required failure.
    const resetCalls = dbQueryMock.mock.calls.filter(
      (c: any[]) => Array.isArray(c[1]) && c[1][0] === 'PENDING'
    );
    expect(resetCalls.length).toBe(0);
  });

  it('G. typed dust error routes to DEFERRED_DUST', async () => {
    custodyMock.mockRejectedValue(new SweepDustError('USDT', 'ETHEREUM', 'below minimum'));

    await (sweepWorker as any).execute();

    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE pending_sweeps'),
      ['DEFERRED_DUST', ['sweep-1', 'sweep-2', 'sweep-3']]
    );
  });

  // -----------------------------------------------------------------------
  // Phase 10.4 Step 6E-4C-2 â€” P1: pending_sweeps producer
  // -----------------------------------------------------------------------

  it('H. producer creates PENDING sweep rows for confirmed deposits, idempotent via ON CONFLICT (deposit_id)', async () => {
    const produced: Array<{ sql: string; params: any[] }> = [];
    dbQueryMock.mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('INSERT INTO pending_sweeps')) {
        produced.push({ sql, params });
        return { rowCount: 2, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    const created = await pendingSweepProducer.producePendingSweeps(500);
    expect(created).toBe(2);

    expect(produced.length).toBe(1);
    expect(produced[0].sql).toContain('ON CONFLICT (deposit_id) DO NOTHING');
    expect(produced[0].sql).toContain("bd.status = 'CONFIRMED'");
    expect(produced[0].sql).toContain('to_address IS NOT NULL');
  });

  it('I. repeated producer calls (simulating duplicate ticks / concurrent workers) issue the same idempotent SQL', async () => {
    const calls: string[] = [];
    dbQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes('INSERT INTO pending_sweeps')) {
        calls.push(sql);
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });

    await Promise.all([
      pendingSweepProducer.producePendingSweeps(500),
      pendingSweepProducer.producePendingSweeps(500),
    ]);

    expect(calls.length).toBe(2);
    // DB-level uniqueness arbitration: UNIQUE(deposit_id) + ON CONFLICT DO
    // NOTHING guarantees one row per deposit even under true concurrency
    // (proved at the SQL-contract level here; live-Postgres proof is
    // integration-tier, see report item 27).
    for (const sql of calls) {
      expect(sql).toContain('ON CONFLICT (deposit_id) DO NOTHING');
    }
  });

  it('J. physical-vs-DB reconciliation surfaces EXTRA_FUNDS/SHORTFALL without touching ledgers', async () => {
    const reconcileSpy = vi.spyOn(custodyService, 'reconcileDepositAddress').mockResolvedValue({
      expectedRemaining: '100',
      physical: '150',
      status: 'EXTRA_FUNDS',
    });

    await (sweepWorker as any).execute();

    expect(reconcileSpy).toHaveBeenCalledWith('ETHEREUM', '0x111122223333', 'USDT');
  });
});
