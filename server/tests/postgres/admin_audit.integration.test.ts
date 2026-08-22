import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { AuthService } from '../../src/services/auth/auth.service';
import { SessionService } from '../../src/services/auth/session.service';
import { AdminService } from '../../src/services/admin/admin.service';
import { AuditService } from '../../src/services/admin/audit.service';
import { KycService } from '../../src/services/compliance/kyc.service';
import { ApiKeyService } from '../../src/services/auth/api-key.service';
import { totpService } from '../../src/services/auth/totp.service';

describe('Phase 7.3: PostgreSQL Admin Audit Logging & Governance Integration Tests', () => {
  let pgPool: PostgresDatabasePool;
  let authService: AuthService;
  let adminService: AdminService;
  let auditService: AuditService;
  let apiKeyService: ApiKeyService;

  let adminUserId: string;
  let targetUserId: string;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    pgPool = new PostgresDatabasePool();
    await pgPool.connect();

    const migrator = new SchemaMigrator(undefined, pgPool);
    await migrator.runMigrations();

    const sessionService = new SessionService(pgPool);
    authService = new AuthService(pgPool, sessionService, totpService);
    const kycService = new KycService(pgPool);
    auditService = new AuditService(pgPool);
    adminService = new AdminService(pgPool, auditService, kycService);
    apiKeyService = new ApiKeyService(pgPool);

    // Create Admin User
    const adminRes = await authService.signup({
      email: `pg_admin_73_${Date.now()}@test.exchange`,
      password: 'AdminPassword123!SecurePg',
      username: `pgadm73_${Date.now().toString().slice(-4)}`,
    });
    adminUserId = adminRes.user.id;
    await pgPool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminUserId]);

    // Create Target User
    const userRes = await authService.signup({
      email: `pg_target_73_${Date.now()}@test.exchange`,
      password: 'UserPassword123!SecurePg',
      username: `pgtrg73_${Date.now().toString().slice(-4)}`,
    });
    targetUserId = userRes.user.id;
  });

  afterAll(async () => {
    if (pgPool) {
      await pgPool.close();
    }
  });

  it('1. Verifies migration 013 applied and admin_audit_logs table exists in PostgreSQL', async () => {
    const tableRes = await pgPool.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'admin_audit_logs'"
    );
    expect(tableRes.rows.length).toBe(1);
  });

  it('2. Records immutable audit log into PostgreSQL on account status modification', async () => {
    const updated = await adminService.updateUserStatus({
      adminUserId,
      userId: targetUserId,
      status: 'SUSPENDED',
      reason: 'PostgreSQL Integration Test Freeze',
      ipAddress: '127.0.0.1',
      userAgent: 'IntegrationTestRunner/1.0',
    });

    expect(updated.accountStatus).toBe('SUSPENDED');

    // Query real PostgreSQL admin_audit_logs table
    const auditRes = await pgPool.query<any>(
      'SELECT * FROM admin_audit_logs WHERE target_user_id = $1 ORDER BY created_at DESC',
      [targetUserId]
    );

    expect(auditRes.rows.length).toBeGreaterThanOrEqual(1);
    const log = auditRes.rows[0];
    expect(log.action).toBe('USER_STATUS_CHANGE');
    expect(log.admin_user_id).toBe(adminUserId);
    expect(log.reason).toBe('PostgreSQL Integration Test Freeze');
    expect(log.ip_address).toBe('127.0.0.1');
    expect(log.user_agent).toBe('IntegrationTestRunner/1.0');
    expect(log.previous_state).toEqual({ accountStatus: 'ACTIVE' });
    expect(log.new_state).toEqual({ accountStatus: 'SUSPENDED' });
  });

  it('3. Records immutable audit log on role promotion and queries via AuditService', async () => {
    await adminService.updateUserRole({
      adminUserId,
      userId: targetUserId,
      role: 'SYSTEM_BOT',
      reason: 'Institutional Liquidity Provider Promotion',
    });

    const logsResult = await auditService.getLogs({
      targetUserId,
      action: 'USER_ROLE_CHANGE',
    });

    expect(logsResult.total).toBe(1);
    expect(logsResult.logs[0].action).toBe('USER_ROLE_CHANGE');
    expect(logsResult.logs[0].newState).toEqual({ role: 'SYSTEM_BOT' });
  });
});
