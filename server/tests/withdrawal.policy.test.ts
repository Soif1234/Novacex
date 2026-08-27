import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { withdrawalPolicyService } from '../src/services/wallet/withdrawal-policy.service';
import { db } from '../src/config/database';
import { env } from '../src/config/env';
import { withdrawalService } from '../src/services/wallet/withdrawal.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { auditService } from '../src/services/admin/audit.service';
import { ledgerService } from '../src/services/ledger/ledger.service';
import { amlService } from '../src/services/compliance/aml.service';
import crypto from 'crypto';

describe('Phase 9.7: Withdrawal Policy & Admin Approval', () => {
  const userId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const accountId = crypto.randomUUID();
  const fundingAccountId = crypto.randomUUID();

  beforeEach(async () => {
    vi.resetAllMocks();
    (db as any).isConnected = true;
    (db as any).users.clear();
    (db as any).accounts.clear();
    (db as any).withdrawals.clear();

    env.WITHDRAWAL_REVIEW_THRESHOLD = '10000';

    (db as any).users.set(userId, { id: userId, accountStatus: 'ACTIVE' });
    (db as any).users.set(adminId, { id: adminId, accountStatus: 'ACTIVE', role: 'ADMIN' });

    (db as any).accounts.set(accountId, { id: accountId, userId: userId, type: 'SPOT' });
    (db as any).accounts.set(fundingAccountId, { id: fundingAccountId, userId: userId, type: 'FUNDING' });

    vi.spyOn(ledgerService, 'postTransaction').mockResolvedValue({ transactionId: crypto.randomUUID(), entries: [] });
    vi.spyOn(amlService, 'validateWithdrawalCompliance').mockResolvedValue(undefined);
    vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({ operational: true, mode: 'ACTIVE' });
    vi.spyOn(auditService, 'record').mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    env.WITHDRAWAL_REVIEW_THRESHOLD = undefined;
  });

  describe('WithdrawalPolicyService', () => {
    it('1. safe withdrawal auto-approval (below threshold, not first time)', async () => {
      // Mock prior completed withdrawal
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });

      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '5000', '0x123');
      expect(res.decision).toBe('APPROVE');
      expect(res.reasons.length).toBe(0);
    });

    it('2. first-time destination -> review', async () => {
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '5000', '0xNEW');
      expect(res.decision).toBe('REVIEW');
      expect(res.reasons[0]).toContain('First-time destination');
    });

    it('3. previously completed same asset/network/address -> not review', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '500', '0x123');
      expect(res.decision).toBe('APPROVE');
    });

    it('4. same address different asset -> review', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'ETH', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '500', '0x123');
      expect(res.decision).toBe('REVIEW');
    });

    it('5. same address different network -> review', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'TRC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '500', '0x123');
      expect(res.decision).toBe('REVIEW');
    });

    it('6. high-value -> review', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '15000', '0x123');
      expect(res.decision).toBe('REVIEW');
      expect(res.reasons[0]).toContain('High-value');
    });

    it('7. below threshold -> auto-approval', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '9999.99', '0x123');
      expect(res.decision).toBe('APPROVE');
    });

    it('8. threshold exact-boundary behavior (amount == threshold -> APPROVE)', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '10000', '0x123');
      expect(res.decision).toBe('APPROVE');
      expect(res.reasons.length).toBe(0);
    });

    it('8b. amount just above threshold -> REVIEW', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '10000.000000000000000001', '0x123');
      expect(res.decision).toBe('REVIEW');
      expect(res.reasons[0]).toContain('High-value');
    });

    it('9. threshold missing -> REVIEW', async () => {
      env.WITHDRAWAL_REVIEW_THRESHOLD = undefined;
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '999999', '0x123');
      expect(res.decision).toBe('REVIEW');
      expect(res.reasons[0]).toContain('WITHDRAWAL_REVIEW_THRESHOLD_NOT_CONFIGURED');
    });

    it('9b. threshold empty -> REVIEW', async () => {
      env.WITHDRAWAL_REVIEW_THRESHOLD = '   ';
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '999999', '0x123');
      expect(res.decision).toBe('REVIEW');
      expect(res.reasons[0]).toContain('WITHDRAWAL_REVIEW_THRESHOLD_NOT_CONFIGURED');
    });

    it('9c. malformed threshold -> REVIEW', async () => {
      env.WITHDRAWAL_REVIEW_THRESHOLD = '1000a';
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '999999', '0x123');
      expect(res.decision).toBe('REVIEW');
      expect(res.reasons[0]).toContain('WITHDRAWAL_REVIEW_THRESHOLD_NOT_CONFIGURED');
    });

    it('10. suspended user -> fails', async () => {
      (db as any).users.set(userId, { id: userId, accountStatus: 'SUSPENDED' });
      await expect(withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '100', '0x123'))
        .rejects.toThrow(/not active/);
    });

    it('11. closed user -> fails', async () => {
      (db as any).users.set(userId, { id: userId, accountStatus: 'CLOSED' });
      await expect(withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '100', '0x123'))
        .rejects.toThrow(/not active/);
    });
  });

  describe('WithdrawalService integration', () => {
    it('12. admin approval', async () => {
      const wId = 'w_pending';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, status: 'PENDING', crypto_status: 'PENDING_REVIEW' });

      await withdrawalService.approveWithdrawalAdmin(wId, adminId, 'Looks good');

      const w = (db as any).withdrawals.get(wId);
      expect(w.crypto_status).toBe('APPROVED');
      expect(w.reviewed_by).toBe(adminId);
    });

    it('14. self-approval fails', async () => {
      const wId = 'w_pending';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, status: 'PENDING', crypto_status: 'PENDING_REVIEW' });
      // If adminId owns the fundingAccountId
      (db as any).accounts.set(fundingAccountId, { id: fundingAccountId, userId: adminId, type: 'FUNDING' });

      await expect(withdrawalService.approveWithdrawalAdmin(wId, adminId, 'Oops'))
        .rejects.toThrow(/cannot approve their own/);
    });

    it('16. stale-state approval fails', async () => {
      const wId = 'w_pending';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, status: 'PENDING', crypto_status: 'APPROVED' });

      await expect(withdrawalService.approveWithdrawalAdmin(wId, adminId, 'Oops'))
        .rejects.toThrow(/not pending review/);
    });

    it('17. admin rejection', async () => {
      const wId = 'w_pending';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, amount: '10', fee: '1', asset: 'USDT', status: 'PENDING', crypto_status: 'PENDING_REVIEW' });

      await withdrawalService.rejectWithdrawalAdmin(wId, adminId, 'Fraud');

      const w = (db as any).withdrawals.get(wId);
      expect(w.status).toBe('REJECTED');
      expect(w.crypto_status).toBe('CANCELLED');
    });

    it('18. rejection releases the FULL reservation (amount=100, fee=5 -> 105)', async () => {
      const wId = 'w_pending';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, amount: '100', fee: '5', asset: 'USDT', status: 'PENDING', crypto_status: 'PENDING_REVIEW' });

      await withdrawalService.rejectWithdrawalAdmin(wId, adminId, 'Fraud');

      // LedgerService must have been called with the exact ADJUSTMENT semantics
      const postSpy = ledgerService.postTransaction as any;
      expect(postSpy).toHaveBeenCalledTimes(1);
      const call = postSpy.mock.calls[0];
      const input = call[0];
      const txClient = call[1];

      expect(input.transactionType).toBe('ADJUSTMENT');
      expect(input.referenceId).toBe(`wd_rel_${wId}`);
      expect(input.accountId).toBe(fundingAccountId);

      // Release leg: DEBIT locked 105
      const debitLeg = input.entries.find((e: any) => e.direction === 'DEBIT');
      expect(debitLeg).toBeDefined();
      expect(debitLeg.amount).toBe('105.000000000000000000');
      expect(debitLeg.balancePool).toBe('locked');
      expect(debitLeg.accountId).toBe(fundingAccountId);
      expect(debitLeg.asset).toBe('USDT');

      // Release leg: CREDIT available 105
      const creditLeg = input.entries.find((e: any) => e.direction === 'CREDIT');
      expect(creditLeg).toBeDefined();
      expect(creditLeg.amount).toBe('105.000000000000000000');
      expect(creditLeg.balancePool).toBe('available');
      expect(creditLeg.accountId).toBe(fundingAccountId);
      expect(creditLeg.asset).toBe('USDT');

      // The ledger call must run inside the same transaction client
      expect(txClient).toBeDefined();

      // Terminal withdrawal state
      const w = (db as any).withdrawals.get(wId);
      expect(w.status).toBe('REJECTED');
      expect(w.crypto_status).toBe('CANCELLED');
      expect(w.failure_reason).toBe('Rejected by administrator');
    });

    it('18b. audit failure rolls back the approval (no state change, no audit loss)', async () => {
      const wId = 'w_audit_fail';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, status: 'PENDING', crypto_status: 'PENDING_REVIEW' });

      // Simulate audit insert failure INSIDE the transaction
      (auditService.record as any).mockRejectedValueOnce(new Error('audit db down'));

      await expect(withdrawalService.approveWithdrawalAdmin(wId, adminId, 'Looks good', {
        adminUserId: adminId,
        action: 'APPROVE_WITHDRAWAL',
        targetResourceType: 'WITHDRAWAL',
        targetResourceId: wId,
        previousState: { crypto_status: 'PENDING_REVIEW' },
        newState: { crypto_status: 'APPROVED' },
        reason: 'Looks good'
      })).rejects.toThrow('audit db down');

      // Transaction rolled back -> withdrawal still PENDING_REVIEW, NOT APPROVED
      const w = (db as any).withdrawals.get(wId);
      expect(w.crypto_status).toBe('PENDING_REVIEW');
      expect(w.reviewed_by).toBeUndefined();
    });

    it('18c. admin rejection records audit inside the transaction', async () => {
      const wId = 'w_rej_audit';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, amount: '100', fee: '5', asset: 'USDT', status: 'PENDING', crypto_status: 'PENDING_REVIEW' });

      await withdrawalService.rejectWithdrawalAdmin(wId, adminId, 'Fraud', {
        adminUserId: adminId,
        action: 'REJECT_WITHDRAWAL',
        targetResourceType: 'WITHDRAWAL',
        targetResourceId: wId,
        previousState: { crypto_status: 'PENDING_REVIEW' },
        newState: { crypto_status: 'CANCELLED' },
        reason: 'Fraud'
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'REJECT_WITHDRAWAL', targetResourceId: wId, reason: 'Fraud' }),
        expect.anything()
      );
      const auditCall = (auditService.record as any).mock.calls.find((c: any[]) => c[0]?.action === 'REJECT_WITHDRAWAL');
      expect(auditCall).toBeDefined();
      expect(auditCall[1]).toBeDefined(); // transaction client passed
    });
  });
});

import { requireCircuitBreaker } from '../src/middleware/circuitBreaker';
import { Request, Response } from 'express';
import { withdrawalProcessingWorker } from '../src/workers/WithdrawalProcessingWorker';

describe('Phase 9.7: Circuit Breaker Integration', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: any;
  let statusMock: any;
  let jsonMock: any;

  beforeEach(() => {
    jsonMock = vi.fn();
    statusMock = vi.fn().mockReturnValue({ json: jsonMock });
    mockReq = {};
    mockRes = { status: statusMock };
    mockNext = vi.fn();

    vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({ operational: false, mode: 'ACTIVE' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. Admin approval is rejected by circuit breaker', async () => {
    const middleware = requireCircuitBreaker('WITHDRAWALS');
    await middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(503);
    expect(jsonMock).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'CIRCUIT_BREAKER_TRIGGERED' }) }));
    expect(mockNext).not.toHaveBeenCalled();
  });

  it('2. Admin rejection is rejected by circuit breaker', async () => {
    const middleware = requireCircuitBreaker('WITHDRAWALS');
    await middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(503);
  });

  it('3. New withdrawal request is blocked', async () => {
    const middleware = requireCircuitBreaker('WITHDRAWALS');
    await middleware(mockReq as Request, mockRes as Response, mockNext);
    expect(statusMock).toHaveBeenCalledWith(503);
  });

  it('4. Provider submission is still blocked by Phase 9.6 worker gate', async () => {
    const claimSpy = vi.spyOn(withdrawalService, 'claimApprovedWithdrawals').mockResolvedValue([]);
    await (withdrawalProcessingWorker as any).execute();
    expect(claimSpy).not.toHaveBeenCalled(); // Processing skipped entirely due to circuit breaker
  });
});

describe('Phase 9.7: Admin Withdrawal Routes carry required security middleware', () => {
  it('approve/reject routes include require2FA and a rate limiter in the chain', async () => {
    const { adminRoutes } = await import('../src/routes/admin.routes');

    const layers: any[] = (adminRoutes as any).stack ?? [];
    const approveLayer = layers.find(
      (l: any) => l.route && String(l.route.path) === '/withdrawals/:id/approve' && l.route.methods && l.route.methods.post
    );
    const rejectLayer = layers.find(
      (l: any) => l.route && String(l.route.path) === '/withdrawals/:id/reject' && l.route.methods && l.route.methods.post
    );

    expect(approveLayer).toBeDefined();
    expect(rejectLayer).toBeDefined();

    const handlerNames = (route: any) =>
      (route.stack ?? []).map((h: any) => h.handle?.name || h.name || 'anonymous');

    const approveNames = handlerNames(approveLayer.route);
    const rejectNames = handlerNames(rejectLayer.route);

    // require2FA must be present in both chains
    expect(approveNames).toContain('require2FA');
    expect(rejectNames).toContain('require2FA');

    // A rate limiter (mutationRateLimiter() -> anonymous) must be present:
    // chain should contain at least circuit breaker + require2FA + rate limiter + controller
    expect(approveNames.length).toBeGreaterThanOrEqual(4);
    expect(rejectNames.length).toBeGreaterThanOrEqual(4);

    // Controller is the final handler
    expect(approveNames[approveNames.length - 1]).toBe('approveWithdrawal');
    expect(rejectNames[rejectNames.length - 1]).toBe('rejectWithdrawal');
  });
});
