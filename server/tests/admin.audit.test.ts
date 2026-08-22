import { describe, it, expect, beforeEach } from 'vitest';
import { adminService } from '../src/services/admin/admin.service';
import { auditService } from '../src/services/admin/audit.service';
import { authService } from '../src/services/auth/auth.service';
import { apiKeyService } from '../src/services/auth/api-key.service';

describe('Phase 7.3: Admin Audit Logging & User Administration Unit Tests', () => {
  let adminId: string;
  let regularUserId: string;

  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    db.reset?.();
    await db.connect();

    // 1. Create Admin
    const adminSignup = await authService.signup({
      email: `admin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
      password: 'AdminPassword123!Secure',
      username: `adm_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    adminId = adminSignup.user.id;
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminId]);

    // 2. Create Regular User
    const userSignup = await authService.signup({
      email: `user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
      password: 'UserPassword123!Secure',
      username: `usr_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    regularUserId = userSignup.user.id;
  });

  it('1. Admin can list users with pagination and KYC information', async () => {
    const res = await adminService.listUsers({ page: 1, pageSize: 10 });
    expect(res.total).toBeGreaterThanOrEqual(2);
    expect(res.users.some((u) => u.id === regularUserId)).toBe(true);
    expect(res.users.some((u) => u.id === adminId)).toBe(true);
  });

  it('2. Admin can inspect full details of a specific user', async () => {
    // Create an API key for regular user
    await apiKeyService.createApiKey({
      userId: regularUserId,
      label: 'Trading Bot',
      permissions: ['READ', 'TRADE'],
    });

    const detail = await adminService.getUserDetail(regularUserId);
    expect(detail.user.id).toBe(regularUserId);
    expect(detail.accounts.length).toBe(3); // SPOT, FUTURES, FUNDING
    expect(detail.kycProfile.tier).toBe('TIER_0');
    expect(detail.activeApiKeysCount).toBe(1);
  });

  it('3. Suspending a user account updates status, invalidates active sessions, and logs audit event', async () => {
    // User logs in to establish an active session
    const login = await authService.login({
      email: (await adminService.getUserDetail(regularUserId)).user.email,
      password: 'UserPassword123!Secure',
    });
    expect(login.sessionToken).toBeDefined();

    // Create an active API key
    const createdKey = await apiKeyService.createApiKey({
      userId: regularUserId,
      label: 'Bot Key',
      permissions: ['READ'],
    });

    // Admin suspends user
    const updated = await adminService.updateUserStatus({
      adminUserId: adminId,
      userId: regularUserId,
      status: 'SUSPENDED',
      reason: 'Suspicious transaction pattern detected',
    });

    expect(updated.accountStatus).toBe('SUSPENDED');

    // Verify audit log recorded
    const auditLogs = await auditService.getLogs({ targetUserId: regularUserId });
    expect(auditLogs.total).toBeGreaterThanOrEqual(1);
    const lastLog = auditLogs.logs[0];
    expect(lastLog.action).toBe('USER_STATUS_CHANGE');
    expect(lastLog.adminUserId).toBe(adminId);
    expect(lastLog.reason).toBe('Suspicious transaction pattern detected');
    expect(lastLog.previousState).toEqual({ accountStatus: 'ACTIVE' });
    expect(lastLog.newState).toEqual({ accountStatus: 'SUSPENDED' });

    // Verify active sessions and API keys count are 0 after suspension
    const detailAfter = await adminService.getUserDetail(regularUserId);
    expect(detailAfter.activeSessionsCount).toBe(0);
    expect(detailAfter.activeApiKeysCount).toBe(0);
  });

  it('4. Updating user role records an immutable audit log with before/after state', async () => {
    const updated = await adminService.updateUserRole({
      adminUserId: adminId,
      userId: regularUserId,
      role: 'SYSTEM_BOT',
      reason: 'Assigned as institutional market maker bot',
    });

    expect(updated.role).toBe('SYSTEM_BOT');

    const auditLogs = await auditService.getLogs({ targetUserId: regularUserId, action: 'USER_ROLE_CHANGE' });
    expect(auditLogs.logs.length).toBe(1);
    expect(auditLogs.logs[0].previousState).toEqual({ role: 'USER' });
    expect(auditLogs.logs[0].newState).toEqual({ role: 'SYSTEM_BOT' });
    expect(auditLogs.logs[0].reason).toBe('Assigned as institutional market maker bot');
  });

  it('5. Protects against self-suspension or self-demotion when sole admin', async () => {
    // Only 1 admin exists (adminId)
    await expect(
      adminService.updateUserStatus({
        adminUserId: adminId,
        userId: adminId,
        status: 'SUSPENDED',
        reason: 'Attempting to self-suspend',
      })
    ).rejects.toThrow(/Cannot suspend the sole active administrator account/);

    await expect(
      adminService.updateUserRole({
        adminUserId: adminId,
        userId: adminId,
        role: 'USER',
        reason: 'Attempting to self-demote',
      })
    ).rejects.toThrow(/Cannot demote the sole active administrator account/);
  });
});
