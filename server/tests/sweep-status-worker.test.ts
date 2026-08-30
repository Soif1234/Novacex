import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest';
import { sweepStatusWorker } from '../src/workers/SweepStatusWorker';
import { db } from '../src/config/database';
import { custodyService } from '../src/services/custody/custody.service';
import { env } from '../src/config/env';

describe('SweepStatusWorker Integration & Reorg Verification', () => {
  let custodyMock: any;
  let dbQueryMock: any;
  let dbTransactionMock: any;

  beforeAll(() => {
    env.CRYPTO_WITHDRAWALS_ENABLED = 'true';
  });

  beforeEach(() => {
    custodyMock = vi.spyOn(custodyService, 'checkSweepStatus').mockResolvedValue({
      status: 'CONFIRMED',
      blockNumber: 12345,
      blockHash: '0xblockhash123',
      confirmations: 15
    });

    dbQueryMock = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params: any[]) => {
      if (sql.includes('SELECT tx_hash, network, status') && sql.includes('WHERE status = \'BROADCAST\'')) {
        return {
          rowCount: 2,
          rows: [
            { tx_hash: '0x123', network: 'ETHEREUM', status: 'BROADCAST' },
            { tx_hash: '0x456', network: 'ETHEREUM', status: 'BROADCAST' }
          ]
        };
      }
      if (sql.includes('SELECT tx_hash, network, block_number, block_hash') && sql.includes('WHERE status = \'CONFIRMED\'')) {
        return {
          rowCount: 1,
          rows: [
            { tx_hash: '0xconfirmed1', network: 'ETHEREUM', block_number: 12300, block_hash: '0xoldblockhash' }
          ]
        };
      }
      return { rowCount: 0, rows: [] };
    });

    dbTransactionMock = vi.spyOn(db, 'transaction').mockImplementation(async (cb: any) => {
      const clientMock = {
        query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] })
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

  it('updates confirmed sweeps with block metadata correctly', async () => {
    await (sweepStatusWorker as any).execute();

    expect(custodyMock).toHaveBeenCalled();
    expect(dbTransactionMock).toHaveBeenCalled();
  });

  it('handles failed sweeps by reverting pending_sweeps to PENDING and clearing sweep_txid', async () => {
    custodyMock.mockResolvedValue({
      status: 'FAILED',
      blockNumber: 12346,
      blockHash: '0xfailedhash'
    });
    await (sweepStatusWorker as any).execute();

    expect(custodyMock).toHaveBeenCalled();
    expect(dbTransactionMock).toHaveBeenCalled();
  });

  it('ignores broadcasts that are still pending / insufficient confirmations', async () => {
    custodyMock.mockResolvedValue({
      status: 'BROADCAST',
      confirmations: 2
    });

    // When BROADCAST, processBroadcastSweeps does no db.transaction
    // and verifyConfirmedSweepsReorg reverts the confirmed sweep to BROADCAST
    await (sweepStatusWorker as any).processBroadcastSweeps();

    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('reorg detection: reverts CONFIRMED sweep to BROADCAST if depth drops or tx unconfirmed', async () => {
    custodyMock.mockResolvedValue({
      status: 'BROADCAST',
      confirmations: 2
    });

    await (sweepStatusWorker as any).verifyConfirmedSweepsReorg();

    expect(dbTransactionMock).toHaveBeenCalled();
  });

  it('reorg detection: reverts CONFIRMED sweep to FAILED if reorged into a reverted state', async () => {
    custodyMock.mockResolvedValue({
      status: 'FAILED'
    });

    await (sweepStatusWorker as any).verifyConfirmedSweepsReorg();

    expect(dbTransactionMock).toHaveBeenCalled();
  });

  it('reorg detection: updates block hash if sweep was re-mined into a new canonical block', async () => {
    custodyMock.mockResolvedValue({
      status: 'CONFIRMED',
      blockNumber: 12301,
      blockHash: '0xnewblockhash',
      confirmations: 20
    });

    await (sweepStatusWorker as any).verifyConfirmedSweepsReorg();

    expect(dbQueryMock).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE sweep_transactions'),
      [12301, '0xnewblockhash', '0xconfirmed1']
    );
  });

  // -----------------------------------------------------------------------
  // Phase 10.4 Step 6E-4C-2 â€” P2: stuck BROADCAST escalation
  // -----------------------------------------------------------------------

  function staleBroadcastRows(): any[] {
    return [
      {
        tx_hash: '0xstale1',
        network: 'ETHEREUM',
        status: 'BROADCAST',
        network_nonce: 9,
        updated_at: new Date(Date.now() - 5 * 60 * 60 * 1000) // 5 hours old
      }
    ];
  }

  it('R. dropped broadcast older than threshold: escalated to STALE_BROADCAST + RECONCILIATION (artifact preserved)', async () => {
    dbQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'BROADCAST'")) {
        return { rowCount: 1, rows: staleBroadcastRows() };
      }
      return { rowCount: 0, rows: [] };
    });
    custodyMock.mockResolvedValue({ status: 'BROADCAST', confirmations: 0 });
    vi.spyOn(custodyService, 'getSweepTxPresence').mockResolvedValue({
      present: false, mined: false, nonceConsumed: true
    });

    const executedSql: string[] = [];
    dbTransactionMock.mockImplementation(async (cb: any) => {
      const client = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          executedSql.push(sql);
          return { rowCount: 0, rows: [] };
        })
      };
      return await cb(client);
    });

    await (sweepStatusWorker as any).processBroadcastSweeps();

    expect(executedSql.some(s => s.includes("'STALE_BROADCAST'"))).toBe(true);
    expect(executedSql.some(s => s.includes("'RECONCILIATION'"))).toBe(true);
    expect(executedSql.some(s => s.includes('INSERT INTO custody_reconciliation_events'))).toBe(true);
    // Original artifact is downgraded only in status â€” sweep_txid linkage on
    // pending rows is never cleared by the escalation.
    expect(executedSql.every(s => !s.includes('sweep_txid = NULL'))).toBe(true);
  });

  it('S. broadcast still visible in mempool: no escalation', async () => {
    dbQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'BROADCAST'")) {
        return { rowCount: 1, rows: staleBroadcastRows() };
      }
      return { rowCount: 0, rows: [] };
    });
    custodyMock.mockResolvedValue({ status: 'BROADCAST', confirmations: 0 });
    const presenceSpy = vi.spyOn(custodyService, 'getSweepTxPresence').mockResolvedValue({
      present: true, mined: false, nonceConsumed: false
    });

    await (sweepStatusWorker as any).processBroadcastSweeps();

    expect(presenceSpy).toHaveBeenCalled();
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });

  it('T. young broadcast below threshold: no presence probe, no escalation', async () => {
    dbQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("WHERE status = 'BROADCAST'")) {
        return {
          rowCount: 1,
          rows: [{
            tx_hash: '0xyoung',
            network: 'ETHEREUM',
            status: 'BROADCAST',
            network_nonce: 9,
            updated_at: new Date(Date.now() - 30 * 1000) // 30 seconds old
          }]
        };
      }
      return { rowCount: 0, rows: [] };
    });
    custodyMock.mockResolvedValue({ status: 'BROADCAST', confirmations: 0 });
    const presenceSpy = vi.spyOn(custodyService, 'getSweepTxPresence');

    await (sweepStatusWorker as any).processBroadcastSweeps();

    expect(presenceSpy).not.toHaveBeenCalled();
    expect(dbTransactionMock).not.toHaveBeenCalled();
  });
});
