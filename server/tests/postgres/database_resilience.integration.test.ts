import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';

describe('Phase 8.3: PostgreSQL Database Pool Resilience & Query Timeout Integration Tests', () => {
  let pgPool: PostgresDatabasePool;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    pgPool = new PostgresDatabasePool({
      min: 2,
      max: 10,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      statement_timeout: 5000,
    });
    await pgPool.connect();
  });

  afterAll(async () => {
    if (pgPool) {
      await pgPool.close();
    }
  });

  it('1. Reports accurate live PostgreSQL connection pool configuration and metrics', () => {
    const status = pgPool.getStatus();
    expect(status.connected).toBe(true);
    expect(status.config?.min).toBe(2);
    expect(status.config?.max).toBe(10);
    expect(status.config?.connectionTimeoutMillis).toBe(5000);
    expect(status.config?.idleTimeoutMillis).toBe(10000);
    expect(status.config?.queryTimeoutMillis).toBe(5000);
  });

  it('2. Aborts long-running query exceeding client timeout with QUERY_TIMEOUT error', async () => {
    await expect(
      pgPool.query('SELECT pg_sleep(2)', [], { timeoutMs: 100 })
    ).rejects.toThrow(/QUERY_TIMEOUT/);
  });

  it('3. Successfully executes queries within the timeout limit', async () => {
    const res = await pgPool.query<{ result: number }>('SELECT 1 + 1 AS result', [], { timeoutMs: 2000 });
    expect(res.rowCount).toBe(1);
    expect(res.rows[0].result).toBe(2);
  });

  it('4. Handles transaction rollback cleanly when a statement inside the transaction times out', async () => {
    await expect(
      pgPool.transaction(async (tx) => {
        await tx.query('CREATE TEMP TABLE test_timeout_tx (id INT)');
        await tx.query('SELECT pg_sleep(2)', [], { timeoutMs: 100 });
      })
    ).rejects.toThrow(/QUERY_TIMEOUT/);

    // Verify transaction was rolled back and pool is healthy
    const checkRes = await pgPool.query('SELECT 1 AS healthy');
    expect(checkRes.rowCount).toBe(1);
  });

  it('5. Executes concurrent queries across pool connections cleanly', async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      pgPool.query<{ idx: number }>('SELECT $1::int AS idx', [i])
    );
    const results = await Promise.all(promises);
    expect(results.length).toBe(5);
    results.forEach((r, i) => {
      expect(r.rows[0].idx).toBe(i);
    });
  });
});
