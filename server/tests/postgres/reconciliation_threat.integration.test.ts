import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { AuthService } from '../../src/services/auth/auth.service';
import { SessionService } from '../../src/services/auth/session.service';
import { WalletService } from '../../src/services/wallet/wallet.service';
import { LedgerService } from '../../src/services/ledger/ledger.service';
import { ReconciliationService } from '../../src/services/compliance/reconciliation.service';
import { ThreatAlertService } from '../../src/services/compliance/threat-alert.service';
import { CircuitBreakerService } from '../../src/services/system/circuit-breaker.service';
import { AuditService } from '../../src/services/admin/audit.service';
import { totpService } from '../../src/services/auth/totp.service';
import { KycService } from '../../src/services/compliance/kyc.service';
import { AmlService } from '../../src/services/compliance/aml.service';

describe('Phase 7.5: PostgreSQL Automated Balance Reconciliation & Threat Alerting Integration Tests', () => {
  let pgPool: PostgresDatabasePool;
  let authService: AuthService;
  let walletService: WalletService;
  let ledgerService: LedgerService;
  let reconciliationService: ReconciliationService;
  let threatAlertService: ThreatAlertService;
  let circuitBreakerService: CircuitBreakerService;
  let auditService: AuditService;
  let adminUserId: string;
  let userAccountId: string;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    pgPool = new PostgresDatabasePool();
    await pgPool.connect();

    const migrator = new SchemaMigrator(undefined, pgPool);
    await migrator.runMigrations();

    const sessionService = new SessionService(pgPool);
    authService = new AuthService(pgPool, sessionService, totpService);
    ledgerService = new LedgerService(pgPool);
    const kycService = new KycService(pgPool);
    const amlService = new AmlService(pgPool);
    walletService = new WalletService(pgPool, ledgerService, kycService, amlService);
    auditService = new AuditService(pgPool);
    threatAlertService = new ThreatAlertService(pgPool, auditService);
    circuitBreakerService = new CircuitBreakerService(pgPool, auditService);
    reconciliationService = new ReconciliationService(pgPool, auditService, threatAlertService, circuitBreakerService);

    // Create Admin User
    const adminRes = await authService.signup({
      email: `pg_admin_75_${Date.now()}@test.exchange`,
      password: 'AdminPassword123!SecurePg',
      username: `pgadm75_${Date.now().toString().slice(-4)}`,
    });
    adminUserId = adminRes.user.id;
    await pgPool.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminUserId]);

    // Create Regular User
    const userRes = await authService.signup({
      email: `pg_trader_75_${Date.now()}@test.exchange`,
      password: 'TraderPassword123!SecurePg',
      username: `pgtrd75_${Date.now().toString().slice(-4)}`,
    });

    const accRes = await pgPool.query<any>(
      'SELECT id FROM accounts WHERE user_id = $1 AND type = $2',
      [userRes.user.id, 'SPOT']
    );
    userAccountId = accRes.rows[0].id;
  });

  afterAll(async () => {
    // Restore circuit breaker state if needed
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

  it('1. Verifies Migration 015 applied and tables exist in PostgreSQL', async () => {
    const reconTable = await pgPool.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'reconciliation_reports'"
    );
    expect(reconTable.rows.length).toBe(1);

    const alertTable = await pgPool.query<any>(
      "SELECT table_name FROM information_schema.tables WHERE table_name = 'security_threat_alerts'"
    );
    expect(alertTable.rows.length).toBe(1);
  });

  it('2. Executes real PostgreSQL reconciliation sweep on active accounts and persists report', async () => {
    // Make legitimate deposit
    await walletService.paperDeposit({
      adminUserId,
      targetAccountId: userAccountId,
      asset: 'USDT',
      amount: '5000',
      referenceId: `pg-recon-dep-${Date.now()}`,
    });

    const report = await reconciliationService.runReconciliation('ADMIN_MANUAL', adminUserId, userAccountId);
    expect(report.status).toBe('PASSED');
    expect(report.discrepanciesCount).toBe(0);

    // Verify row in PostgreSQL
    const checkRes = await pgPool.query<any>(
      'SELECT * FROM reconciliation_reports WHERE id = $1',
      [report.id]
    );
    expect(checkRes.rows.length).toBe(1);
    expect(checkRes.rows[0].status).toBe('PASSED');
  });

  it('3. Generates, stores, and resolves security threat alerts in real PostgreSQL database', async () => {
    const alert = await threatAlertService.createAlert({
      severity: 'CRITICAL',
      category: 'UNAUTHORIZED_ACCESS',
      title: 'PostgreSQL Real DB Alert Test',
      description: 'Simulated threat alert in PostgreSQL integration test',
      metadata: { env: 'postgres_integration_test' },
    });

    expect(alert.status).toBe('ACTIVE');

    // Verify persisted in PostgreSQL
    const checkAlert = await pgPool.query<any>(
      'SELECT * FROM security_threat_alerts WHERE id = $1',
      [alert.id]
    );
    expect(checkAlert.rows.length).toBe(1);
    expect(checkAlert.rows[0].status).toBe('ACTIVE');

    // Admin resolves alert
    const resolved = await threatAlertService.resolveAlert(alert.id, {
      adminUserId,
      status: 'RESOLVED',
      resolutionNotes: 'PostgreSQL alert confirmed and resolved in integration test',
    });

    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedBy).toBe(adminUserId);

    // Check resolution persisted in PostgreSQL
    const checkResolved = await pgPool.query<any>(
      'SELECT status, resolved_by, resolution_notes FROM security_threat_alerts WHERE id = $1',
      [alert.id]
    );
    expect(checkResolved.rows[0].status).toBe('RESOLVED');
    expect(checkResolved.rows[0].resolved_by).toBe(adminUserId);
  });
});
