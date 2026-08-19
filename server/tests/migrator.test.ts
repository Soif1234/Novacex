import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SchemaMigrator } from '../src/config/migrator';
import { IDatabaseConnection, QueryResult } from '../src/config/database';

describe('Database Schema Migrator (server/src/config/migrator.ts)', () => {
  let mockDb: IDatabaseConnection;
  let queryLog: Array<{ sql: string; params?: unknown[] }>;

  beforeEach(() => {
    queryLog = [];
    mockDb = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockImplementation(async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
        queryLog.push({ sql, params });
        if (sql.includes('SELECT version, name, checksum')) {
          return { rows: [] as T[], rowCount: 0 };
        }
        return { rows: [] as T[], rowCount: 0 };
      }),
      transaction: vi.fn().mockImplementation(async (cb) => cb(mockDb)),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
      getStatus: vi.fn().mockReturnValue({ connected: true, poolSize: 2, activeConnections: 0, idleConnections: 2 })
    };
  });

  it('1. Reads migration files in sorted sequential order', () => {
    const migrator = new SchemaMigrator(undefined, mockDb);
    const files = migrator.getMigrationFiles();

    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files[0].filename).toBe('001_create_users_and_auth.sql');
    expect(files[1].filename).toBe('002_create_accounts_and_wallets.sql');
    expect(files[2].filename).toBe('003_create_double_entry_ledger.sql');
    expect(files[3].filename).toBe('004_create_spot_orders_and_trades.sql');
    expect(files[4].filename).toBe('005_create_futures_orders_and_positions.sql');
  });

  it('2. Computes valid SHA-256 checksums for each migration script', () => {
    const migrator = new SchemaMigrator(undefined, mockDb);
    const files = migrator.getMigrationFiles();

    files.forEach(f => {
      expect(f.checksum).toBeDefined();
      expect(f.checksum.length).toBe(64); // Hex SHA-256
      expect(f.sql.length).toBeGreaterThan(50);
    });
  });

  it('3. Successfully verifies integrity of all migration scripts', () => {
    const migrator = new SchemaMigrator(undefined, mockDb);
    const result = migrator.verifyIntegrity();

    expect(result.valid).toBe(true);
    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.files).toContain('001_create_users_and_auth.sql');
    expect(result.files).toContain('003_create_double_entry_ledger.sql');
  });

  it('4. Executes pending migrations and logs schema_migrations insertions', async () => {
    const migrator = new SchemaMigrator(undefined, mockDb);
    const result = await migrator.runMigrations();

    expect(result.total).toBeGreaterThanOrEqual(5);
    expect(result.applied).toContain('001_create_users_and_auth.sql');
    expect(result.applied).toContain('005_create_futures_orders_and_positions.sql');

    // Verify insertion queries into schema_migrations table
    const inserts = queryLog.filter(q => q.sql.includes('INSERT INTO schema_migrations'));
    expect(inserts.length).toBe(result.total);
    expect(inserts[0].params?.[0]).toBe('001');
    expect(inserts[0].params?.[1]).toBe('001_create_users_and_auth');
  });

  it('5. Skips already applied migrations idempotently', async () => {
    // Mock that migrations 001 and 002 are already applied
    vi.spyOn(mockDb, 'query').mockImplementation(async <T>(sql: string, params?: unknown[]): Promise<QueryResult<T>> => {
      if (sql.includes('SELECT version, name, checksum')) {
        return {
          rows: [
            { version: '001', name: '001_create_users_and_auth', checksum: 'abc', appliedAt: new Date() },
            { version: '002', name: '002_create_accounts_and_wallets', checksum: 'def', appliedAt: new Date() }
          ] as unknown as T[],
          rowCount: 2
        };
      }
      return { rows: [] as T[], rowCount: 0 };
    });

    const migrator = new SchemaMigrator(undefined, mockDb);
    const pending = await migrator.getPendingMigrations();

    expect(pending.map(p => p.version)).not.toContain('001');
    expect(pending.map(p => p.version)).not.toContain('002');
    expect(pending.map(p => p.version)).toContain('003');
    expect(pending.map(p => p.version)).toContain('004');
    expect(pending.map(p => p.version)).toContain('005');
  });
});
