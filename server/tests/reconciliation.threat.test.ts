import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { reconciliationService } from '../src/services/compliance/reconciliation.service';
import { threatAlertService } from '../src/services/compliance/threat-alert.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { auditService } from '../src/services/admin/audit.service';
import { authService } from '../src/services/auth/auth.service';
import { walletService } from '../src/services/wallet/wallet.service';

describe('Phase 7.5: Automated Balance Reconciliation & Threat Alerting Unit Tests', () => {
  let adminId: string;
  let userAccountId: string;
  let userId: string;

  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    db.reset?.();
    circuitBreakerService.resetCache();
    await db.connect();

    // 1. Create Admin User
    const adminSignup = await authService.signup({
      email: `recon_admin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
      password: 'AdminPassword123!Secure',
      username: `reconadm_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    adminId = adminSignup.user.id;
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminId]);

    // 2. Create Regular Trader
    const userSignup = await authService.signup({
      email: `recon_trader_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
      password: 'TraderPassword123!Secure',
      username: `trader_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    userId = userSignup.user.id;

    const accRes = await db.query<any>('SELECT id FROM accounts WHERE user_id = $1 AND type = $2', [userId, 'SPOT']);
    userAccountId = accRes.rows[0].id;
  });

  it('1. Clean exchange state with consistent deposits passes reconciliation with 0 discrepancies', async () => {
    // Perform legitimate paper deposit (creates ledger entries and updates wallet_balances)
    await walletService.paperDeposit({
      adminUserId: adminId,
      targetAccountId: userAccountId,
      asset: 'USDT',
      amount: '5000',
      referenceId: `legit-dep-${Date.now()}`,
    });

    const report = await reconciliationService.runReconciliation('SYSTEM_WORKER');
    expect(report.status).toBe('PASSED');
    expect(report.discrepanciesCount).toBe(0);
    expect(report.details.length).toBe(0);
    expect(report.accountsChecked).toBeGreaterThanOrEqual(1);

    // Verify audit log for reconciliation
    const auditLogs = await auditService.getLogs({ action: 'RECONCILIATION_RUN' });
    expect(auditLogs.total).toBeGreaterThanOrEqual(1);
    expect(auditLogs.logs[0].newState?.status).toBe('PASSED');
  });

  it('2. Detects balance mismatch when wallet balance artificially diverges from ledger entries', async () => {
    const { db } = await import('../src/config/database');

    // Deposit 1000 legitimately
    await walletService.paperDeposit({
      adminUserId: adminId,
      targetAccountId: userAccountId,
      asset: 'USDT',
      amount: '1000',
      referenceId: `legit-dep-2-${Date.now()}`,
    });

    // Artificially corrupt wallet balance table directly (e.g. simulating silent DB tampering)
    await db.query(
      `UPDATE wallet_balances
       SET available_balance = '99999'
       WHERE account_id = $1 AND asset = 'USDT'`,
      [userAccountId]
    );

    const report = await reconciliationService.runReconciliation('ADMIN_MANUAL', adminId);
    expect(report.status).toBe('DISCREPANCY_DETECTED');
    expect(report.discrepanciesCount).toBeGreaterThanOrEqual(1);

    const mismatch = report.details.find(d => d.type === 'BALANCE_MISMATCH' && d.accountId === userAccountId);
    expect(mismatch).toBeDefined();
    expect(mismatch?.walletTotal).toContain('99999');
    expect(mismatch?.ledgerComputed).toContain('1000');

    // Threat alert must be generated with CRITICAL severity
    const alerts = await threatAlertService.getAlerts({ category: 'RECONCILIATION_MISMATCH' });
    expect(alerts.total).toBeGreaterThanOrEqual(1);
    expect(alerts.alerts[0].severity).toBe('CRITICAL');

    // Operational circuit breaker must automatically trip to HALT_WITHDRAWALS
    const cbState = await circuitBreakerService.getState();
    expect(cbState.mode).toBe('HALT_WITHDRAWALS');
    expect(cbState.isWithdrawalsEnabled).toBe(false);
  });

  it('3. Detects unauthorized negative balances on non-system accounts', async () => {
    const { db } = await import('../src/config/database');

    // Directly insert negative balance
    await db.query(
      `INSERT INTO wallet_balances (id, account_id, asset, available_balance, locked_balance, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [crypto.randomUUID(), userAccountId, 'BTC', '-0.5', '0']
    );

    const report = await reconciliationService.runReconciliation('SYSTEM_WORKER');
    expect(report.status).toBe('DISCREPANCY_DETECTED');

    const negativeDiscrepancy = report.details.find(d => d.type === 'NEGATIVE_BALANCE' && d.accountId === userAccountId);
    expect(negativeDiscrepancy).toBeDefined();
    expect(negativeDiscrepancy?.walletAvailable).toBe('-0.5');
  });

  it('4. Detects double-entry zero-sum invariant violation across ledger transaction legs', async () => {
    const { db } = await import('../src/config/database');

    const corruptTxId = crypto.randomUUID();
    // Insert parent transaction as INTERNAL_TRANSFER
    await db.query(
      `INSERT INTO ledger_transactions (id, account_id, transaction_type, reference_id, description, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [corruptTxId, userAccountId, 'INTERNAL_TRANSFER', 'corrupt-ref-1', 'Corrupt multi-leg transaction']
    );

    // Insert single-legged unbalanced credit entry
    await db.query(
      `INSERT INTO ledger_entries (
        id, transaction_id, account_id, asset, direction, amount, balance_after, created_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [crypto.randomUUID(), corruptTxId, userAccountId, 'ETH', 'CREDIT', '10', '10']
    );

    const report = await reconciliationService.runReconciliation('SYSTEM_WORKER');
    expect(report.status).toBe('DISCREPANCY_DETECTED');

    const zeroSumViolation = report.details.find(d => d.type === 'DOUBLE_ENTRY_VIOLATION' && d.transactionId === corruptTxId);
    expect(zeroSumViolation).toBeDefined();
  });

  it('5. Threat alert lifecycle: query and admin resolution with mandatory notes', async () => {
    const createdAlert = await threatAlertService.createAlert({
      severity: 'HIGH',
      category: 'RATE_LIMIT_ANOMALY',
      title: 'Suspicious Burst Login Attempts',
      description: 'IP 192.168.1.100 triggered 50 login attempts in 10 seconds',
      metadata: { ip: '192.168.1.100', count: 50 },
    });

    expect(createdAlert.status).toBe('ACTIVE');
    expect(createdAlert.severity).toBe('HIGH');

    // Admin resolves alert
    const resolved = await threatAlertService.resolveAlert(createdAlert.id, {
      adminUserId: adminId,
      status: 'RESOLVED',
      resolutionNotes: 'IP investigated and confirmed legitimate stress test traffic',
      ipAddress: '127.0.0.1',
    });

    expect(resolved.status).toBe('RESOLVED');
    expect(resolved.resolvedBy).toBe(adminId);
    expect(resolved.resolutionNotes).toBe('IP investigated and confirmed legitimate stress test traffic');

    // Verify audit log for alert resolution
    const auditLogs = await auditService.getLogs({ action: 'SECURITY_ALERT_RESOLVED' });
    expect(auditLogs.total).toBeGreaterThanOrEqual(1);
    expect(auditLogs.logs[0].targetResourceId).toBe(createdAlert.id);
  });

  it('6. Requires non-empty resolution notes to resolve threat alerts', async () => {
    const alert = await threatAlertService.createAlert({
      severity: 'MEDIUM',
      category: 'UNAUTHORIZED_ACCESS',
      title: 'Invalid API Key Signature',
      description: 'HMAC signature verification failed multiple times',
    });

    await expect(
      threatAlertService.resolveAlert(alert.id, {
        adminUserId: adminId,
        status: 'RESOLVED',
        resolutionNotes: '   ',
      })
    ).rejects.toThrow(/Resolution notes are mandatory/);
  });
});
