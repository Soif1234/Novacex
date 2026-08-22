import { describe, it, expect, beforeEach } from 'vitest';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { auditService } from '../src/services/admin/audit.service';
import { authService } from '../src/services/auth/auth.service';

describe('Phase 7.4: System Circuit Breakers & Operational Kill-Switches Unit Tests', () => {
  let adminId: string;

  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    db.reset?.();
    circuitBreakerService.resetCache();
    await db.connect();

    // Create Admin User
    const adminSignup = await authService.signup({
      email: `cb_admin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@novacex.io`,
      password: 'AdminPassword123!Secure',
      username: `cbadm_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    adminId = adminSignup.user.id;
    await db.query("UPDATE users SET role = 'ADMIN' WHERE id = $1", [adminId]);
  });

  it('1. Default system state is SYSTEM_ACTIVE with all subsystems operational', async () => {
    const state = await circuitBreakerService.getState();
    expect(state.mode).toBe('SYSTEM_ACTIVE');
    expect(state.isSpotTradingEnabled).toBe(true);
    expect(state.isFuturesTradingEnabled).toBe(true);
    expect(state.isWithdrawalsEnabled).toBe(true);
    expect(state.isDepositsEnabled).toBe(true);

    const publicStatus = await circuitBreakerService.getPublicStatus();
    expect(publicStatus.isOperational).toBe(true);
    expect(publicStatus.subsystems.spotTrading).toBe(true);
  });

  it('2. HALT_ALL emergency freeze disables all trading, deposits, and withdrawals', async () => {
    const haltedState = await circuitBreakerService.halt({
      adminUserId: adminId,
      mode: 'HALT_ALL',
      reason: 'Extreme market volatility spike and Oracle anomaly',
    });

    expect(haltedState.mode).toBe('HALT_ALL');
    expect(haltedState.isSpotTradingEnabled).toBe(false);
    expect(haltedState.isFuturesTradingEnabled).toBe(false);
    expect(haltedState.isWithdrawalsEnabled).toBe(false);
    expect(haltedState.isDepositsEnabled).toBe(false);
    expect(haltedState.haltReason).toBe('Extreme market volatility spike and Oracle anomaly');

    // Fast pre-flight check confirms non-operational
    const spotCheck = await circuitBreakerService.isSubsystemOperational('SPOT_TRADING');
    expect(spotCheck.operational).toBe(false);
    expect(spotCheck.reason).toBe('Extreme market volatility spike and Oracle anomaly');

    const wdCheck = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
    expect(wdCheck.operational).toBe(false);

    // Verify audit log recorded
    const logs = await auditService.getLogs({ action: 'SYSTEM_HALT' });
    expect(logs.total).toBeGreaterThanOrEqual(1);
    expect(logs.logs[0].adminUserId).toBe(adminId);
    expect(logs.logs[0].targetResourceType).toBe('SYSTEM');
    expect(logs.logs[0].reason).toBe('Extreme market volatility spike and Oracle anomaly');
  });

  it('3. HALT_TRADING disables Spot & Futures while preserving deposits & withdrawals', async () => {
    const halted = await circuitBreakerService.halt({
      adminUserId: adminId,
      mode: 'HALT_TRADING',
      reason: 'Matching engine database upgrade',
    });

    expect(halted.mode).toBe('HALT_TRADING');
    expect(halted.isSpotTradingEnabled).toBe(false);
    expect(halted.isFuturesTradingEnabled).toBe(false);
    expect(halted.isWithdrawalsEnabled).toBe(true);
    expect(halted.isDepositsEnabled).toBe(true);

    const spotCheck = await circuitBreakerService.isSubsystemOperational('SPOT_TRADING');
    expect(spotCheck.operational).toBe(false);

    const wdCheck = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
    expect(wdCheck.operational).toBe(true);
  });

  it('4. HALT_WITHDRAWALS freezes user withdrawals while preserving matching', async () => {
    const halted = await circuitBreakerService.halt({
      adminUserId: adminId,
      mode: 'HALT_WITHDRAWALS',
      reason: 'Automated ledger balance reconciliation investigation',
    });

    expect(halted.mode).toBe('HALT_WITHDRAWALS');
    expect(halted.isSpotTradingEnabled).toBe(true);
    expect(halted.isFuturesTradingEnabled).toBe(true);
    expect(halted.isWithdrawalsEnabled).toBe(false);
    expect(halted.isDepositsEnabled).toBe(true);

    const spotCheck = await circuitBreakerService.isSubsystemOperational('SPOT_TRADING');
    expect(spotCheck.operational).toBe(true);

    const wdCheck = await circuitBreakerService.isSubsystemOperational('WITHDRAWALS');
    expect(wdCheck.operational).toBe(false);
  });

  it('5. Resuming operations restores SYSTEM_ACTIVE and logs audit record', async () => {
    // Halt first
    await circuitBreakerService.halt({
      adminUserId: adminId,
      mode: 'HALT_ALL',
      reason: 'Test halt',
    });

    // Resume all
    const resumed = await circuitBreakerService.resume({
      adminUserId: adminId,
      reason: 'Investigation resolved, systems operating normally',
      resumeAll: true,
    });

    expect(resumed.mode).toBe('SYSTEM_ACTIVE');
    expect(resumed.isSpotTradingEnabled).toBe(true);
    expect(resumed.isFuturesTradingEnabled).toBe(true);
    expect(resumed.isWithdrawalsEnabled).toBe(true);
    expect(resumed.isDepositsEnabled).toBe(true);
    expect(resumed.haltReason).toBeNull();

    const publicStatus = await circuitBreakerService.getPublicStatus();
    expect(publicStatus.isOperational).toBe(true);

    // Verify audit log for resume
    const logs = await auditService.getLogs({ action: 'SYSTEM_RESUME' });
    expect(logs.total).toBeGreaterThanOrEqual(1);
    expect(logs.logs[0].reason).toBe('Investigation resolved, systems operating normally');
  });

  it('6. Requires non-empty reason for halt and resume', async () => {
    await expect(
      circuitBreakerService.halt({
        adminUserId: adminId,
        mode: 'HALT_ALL',
        reason: '   ',
      })
    ).rejects.toThrow(/valid operational reason is required/);

    await expect(
      circuitBreakerService.resume({
        adminUserId: adminId,
        reason: '',
      })
    ).rejects.toThrow(/valid operational reason is required/);
  });
});
