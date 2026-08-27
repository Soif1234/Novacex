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

    it('8. threshold exact-boundary behavior', async () => {
      (db as any).withdrawals.set('w1', {
        id: 'w1', account_id: accountId, asset: 'USDT', network: 'ERC20',
        destination_address: '0x123', status: 'COMPLETED'
      });
      const res = await withdrawalPolicyService.evaluate(userId, accountId, 'USDT', 'ERC20', '10000', '0x123');
      expect(res.decision).toBe('REVIEW');
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

    it('18. rejection releases reservation', async () => {
      const wId = 'w_pending';
      (db as any).withdrawals.set(wId, { id: wId, account_id: fundingAccountId, amount: '10', fee: '1', asset: 'USDT', status: 'PENDING', crypto_status: 'PENDING_REVIEW' });

      await withdrawalService.rejectWithdrawalAdmin(wId, adminId, 'Fraud');

      expect(ledgerService.postTransaction).toHaveBeenCalled();
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
