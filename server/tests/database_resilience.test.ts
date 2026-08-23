import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PostgresDatabasePool, InMemoryDatabasePool } from '../src/config/database';
import { env } from '../src/config/env';

describe('Phase 8.3: Database Pool Resilience & Query Timeout Controls Unit Tests', () => {
  describe('1. Configuration & Status Diagnostics', () => {
    it('initializes PostgresDatabasePool with configured pool bounds and timeouts', () => {
      const customPool = new PostgresDatabasePool({
        host: 'localhost',
        port: 5432,
        database: 'test_db',
        user: 'test_user',
        password: 'test_password',
        min: 3,
        max: 25,
        connectionTimeoutMillis: 4000,
        idleTimeoutMillis: 15000,
        statement_timeout: 8000,
      });

      const status = customPool.getStatus();
      expect(status.config).toBeDefined();
      expect(status.config?.min).toBe(3);
      expect(status.config?.max).toBe(25);
      expect(status.config?.connectionTimeoutMillis).toBe(4000);
      expect(status.config?.idleTimeoutMillis).toBe(15000);
      expect(status.config?.queryTimeoutMillis).toBe(8000);
    });

    it('InMemoryDatabasePool reports valid database status and configuration', () => {
      const memPool = new InMemoryDatabasePool();
      const status = memPool.getStatus();

      expect(status.config).toBeDefined();
      expect(status.config?.min).toBe(env.DB_POOL_MIN);
      expect(status.config?.max).toBe(env.DB_POOL_MAX);
      expect(status.waitingClients).toBe(0);
    });
  });

  describe('2. Query Timeout Protection', () => {
    it('enforces query timeout when a query exceeds timeoutMs threshold', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500))),
        release: vi.fn(),
      };

      const customPool = new PostgresDatabasePool();
      // Inject mock pool with hanging query
      (customPool as any).pool = {
        totalCount: 1,
        idleCount: 1,
        waitingCount: 0,
        query: vi.fn().mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 500))),
        connect: vi.fn().mockResolvedValue(mockClient),
        end: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
      };

      // Executing with 50ms timeout must reject with QUERY_TIMEOUT error
      await expect(
        customPool.query('SELECT pg_sleep(10)', [], { timeoutMs: 50 })
      ).rejects.toThrow(/QUERY_TIMEOUT/);
    });

    it('executes fast queries within timeout window successfully', async () => {
      const customPool = new PostgresDatabasePool();
      (customPool as any).pool = {
        totalCount: 1,
        idleCount: 1,
        waitingCount: 0,
        query: vi.fn().mockResolvedValue({ rows: [{ id: 1, val: 'ok' }], rowCount: 1 }),
        connect: vi.fn(),
        end: vi.fn().mockResolvedValue(undefined),
        on: vi.fn(),
      };

      const result = await customPool.query('SELECT 1', [], { timeoutMs: 1000 });
      expect(result.rowCount).toBe(1);
      expect(result.rows[0]).toEqual({ id: 1, val: 'ok' });
    });
  });

  describe('3. Transaction Safety & Non-Retry Semantics', () => {
    it('rolls back transaction on error and does NOT silently retry', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation(async (sql: string) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('FAIL_HERE')) throw new Error('Simulated balance lock failure');
          return { rows: [] };
        }),
        release: vi.fn(),
      };

      const customPool = new PostgresDatabasePool();
      (customPool as any).pool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        on: vi.fn(),
      };

      let executionAttempts = 0;
      const txPromise = customPool.transaction(async (tx) => {
        executionAttempts++;
        await tx.query('INSERT INTO transactions ...');
        await tx.query('FAIL_HERE');
      });

      await expect(txPromise).rejects.toThrow('Simulated balance lock failure');
      expect(executionAttempts).toBe(1); // Never retried
      expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalledTimes(1);
    });

    it('enforces query timeout inside transaction client', async () => {
      const mockClient = {
        query: vi.fn().mockImplementation((sql: string) => {
          if (sql === 'BEGIN' || sql === 'ROLLBACK') return Promise.resolve({ rows: [] });
          return new Promise((resolve) => setTimeout(resolve, 500));
        }),
        release: vi.fn(),
      };

      const customPool = new PostgresDatabasePool();
      (customPool as any).pool = {
        connect: vi.fn().mockResolvedValue(mockClient),
        on: vi.fn(),
      };

      await expect(
        customPool.transaction(async (tx) => {
          await tx.query('SELECT FOR UPDATE ...', [], { timeoutMs: 50 });
        })
      ).rejects.toThrow(/QUERY_TIMEOUT/);

      expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
      expect(mockClient.release).toHaveBeenCalled();
    });
  });

  describe('4. Error Handling & Pool Lifecycle', () => {
    it('handles unexpected idle client errors gracefully without process crash', () => {
      let errorHandler: ((err: Error) => void) | undefined;

      const customPool = new PostgresDatabasePool();
      (customPool as any).pool = {
        on: vi.fn((event: string, handler: any) => {
          if (event === 'error') errorHandler = handler;
        }),
        end: vi.fn().mockResolvedValue(undefined),
      };

      const newPool = new PostgresDatabasePool();
      // Emulate pool emitting error
      expect(() => {
        (newPool as any).pool.emit?.('error', new Error('Connection terminated unexpectedly'));
      }).not.toThrow();
    });

    it('closes pool cleanly during graceful shutdown', async () => {
      const endMock = vi.fn().mockResolvedValue(undefined);
      const customPool = new PostgresDatabasePool();
      (customPool as any).pool = {
        end: endMock,
        on: vi.fn(),
      };
      (customPool as any).isConnected = true;

      await customPool.close();
      expect(endMock).toHaveBeenCalledTimes(1);
      expect(customPool.getStatus().connected).toBe(false);
    });
  });
});
