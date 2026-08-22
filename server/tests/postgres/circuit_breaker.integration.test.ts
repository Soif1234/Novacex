import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { AuthService } from '../../src/services/auth/auth.service';
import { SessionService } from '../../src/services/auth/session.service';
import { CircuitBreakerService } from '../../src/services/system/circuit-breaker.service';
import { AuditService } from '../../src/services/admin/audit.service';
import { totpService } from '../../src/services/auth/totp.service';

describe('Phase 7.4: PostgreSQL System Circuit Breaker Integration Tests', () => {
  let pgPool: PostgresDatabasePool;
  let authService: AuthService;
  let circuitBreakerService: CircuitBreakerService;
  let auditService: AuditService;
  let adminUserId: string;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    pgPool = new PostgresDatabasePool();
    await pgPool.connect();

    const migrator = new SchemaMigrator(undefined, pgPool);
    await migrator.runMigrations();

    const sessionService = new SessionService(pgPool);
    authService = new AuthService(pgPool, sessionService, totpService);
    auditService = new AuditService(pgPool);
    circuitBreakerService = new CircuitBreakerService(pgPool, auditService);

    // Create Admin User
    const adminRes = await authService.signup({
      email: `pg_admin_74_${Date.now()}@test.exchange`,
      password: 'AdminPassword123!SecurePg',
      username: `pgadm74_${Date.now().toString().slice(-4)}`,
    });
    adminUserId = adminRes.user.id;
    await pgPool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminUserId]);
  });

  afterAll(async () => {
    // Restore active state before closing
    if (circuitBreakerService && adminUserId) {
      await circuitBreakerService.resume({
        adminUserId,
        reason: 'Integration test teardown cleanup',
        resumeAll: true,
      });
    }
    if (pgPool) {
      await pgPool.close();
    }
  });

  it('1. Verifies Migration 014 applied and system_circuit_breakers table exists in PostgreSQL', async () => {
    const tableRes = await pgPool.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'system_circuit_breakers'"
    );
    expect(tableRes.rows.length).toBe(1);

    const rowRes = await pgPool.query<any>(
      "SELECT * FROM system_circuit_breakers WHERE id = 'SYSTEM_GLOBAL'"
    );
    expect(rowRes.rows.length).toBe(1);
  });

  it('2. Triggers emergency HALT_ALL in real PostgreSQL and persists durable state', async () => {
    const halted = await circuitBreakerService.halt({
      adminUserId,
      mode: 'HALT_ALL',
      reason: 'PostgreSQL Real DB Emergency Simulation',
      ipAddress: '10.0.0.1',
      userAgent: 'PGIntegrationTest/1.0',
    });

    expect(halted.mode).toBe('HALT_ALL');
    expect(halted.isSpotTradingEnabled).toBe(false);
    expect(halted.isWithdrawalsEnabled).toBe(false);

    // Direct SQL verification against PostgreSQL
    const checkRes = await pgPool.query<any>(
      "SELECT mode, is_spot_trading_enabled, is_withdrawals_enabled, halt_reason FROM system_circuit_breakers WHERE id = 'SYSTEM_GLOBAL'"
    );
    expect(checkRes.rows[0].mode).toBe('HALT_ALL');
    expect(checkRes.rows[0].is_spot_trading_enabled).toBe(false);
    expect(checkRes.rows[0].is_withdrawals_enabled).toBe(false);
    expect(checkRes.rows[0].halt_reason).toBe('PostgreSQL Real DB Emergency Simulation');

    // Verify audit log row in PostgreSQL
    const auditRes = await pgPool.query<any>(
      "SELECT * FROM admin_audit_logs WHERE action = 'SYSTEM_HALT' AND admin_user_id = $1 ORDER BY created_at DESC",
      [adminUserId]
    );
    expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
    expect(auditRes.rows[0].reason).toBe('PostgreSQL Real DB Emergency Simulation');
  });

  it('3. Resumes operations in PostgreSQL and restores SYSTEM_ACTIVE state', async () => {
    const resumed = await circuitBreakerService.resume({
      adminUserId,
      reason: 'PostgreSQL Emergency Cleared',
      resumeAll: true,
      ipAddress: '10.0.0.1',
      userAgent: 'PGIntegrationTest/1.0',
    });

    expect(resumed.mode).toBe('SYSTEM_ACTIVE');
    expect(resumed.isSpotTradingEnabled).toBe(true);
    expect(resumed.isWithdrawalsEnabled).toBe(true);

    const checkRes = await pgPool.query<any>(
      "SELECT mode, is_spot_trading_enabled, is_withdrawals_enabled, halt_reason FROM system_circuit_breakers WHERE id = 'SYSTEM_GLOBAL'"
    );
    expect(checkRes.rows[0].mode).toBe('SYSTEM_ACTIVE');
    expect(checkRes.rows[0].is_spot_trading_enabled).toBe(true);
    expect(checkRes.rows[0].halt_reason).toBeNull();
  });
});
