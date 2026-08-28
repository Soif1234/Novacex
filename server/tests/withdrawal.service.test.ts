import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WithdrawalService } from '../src/services/wallet/withdrawal.service';
import { IDatabaseConnection } from '../src/config/database';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { AmlService } from '../src/services/compliance/aml.service';
import { withdrawalPolicyService } from '../src/services/wallet/withdrawal-policy.service';
import { AppError } from '../src/middleware/errorHandler';

describe('WithdrawalService', () => {
  let withdrawalService: WithdrawalService;
  let mockDb: IDatabaseConnection;
  let mockLedger: LedgerService;
  let mockAml: AmlService;
  let mockTxClient: any;

  beforeEach(() => {
    vi.spyOn(withdrawalPolicyService, 'evaluate').mockResolvedValue({
      decision: 'APPROVE',
      reasons: []
    });

    mockTxClient = {
      query: vi.fn(),
    };

    mockDb = {
      query: vi.fn().mockResolvedValue({ rows: [{ email: 'test@example.com' }] }),
      transaction: vi.fn(async (cb) => await cb(mockTxClient)),
    } as unknown as IDatabaseConnection;

    mockLedger = {
      postTransaction: vi.fn().mockResolvedValue({ transactionId: 'test-ledger-id' }),
    } as unknown as LedgerService;

    mockAml = {
      validateWithdrawalCompliance: vi.fn().mockResolvedValue(true),
    } as unknown as AmlService;

    withdrawalService = new WithdrawalService(mockDb, mockLedger, mockAml);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cryptoWithdraw', () => {
    it('should successfully reserve a valid withdrawal from FUNDING account', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-123' }] }) // user row lock (P0-1 serialization)
        .mockResolvedValueOnce({ rows: [{ id: 'account-123', type: 'FUNDING' }] }) // account
        .mockResolvedValueOnce({ rows: [{ is_active: true, min_withdrawal: '10', withdrawal_fee: '2', requires_memo: false, address_format: 'EVM_HEX' }] }) // network
        .mockResolvedValueOnce({ rows: [{ id: 'withdrawal-123', account_id: 'account-123', asset: 'USDT', network: 'ETH', amount: '100', fee: '2', status: 'PENDING', crypto_status: 'APPROVED' }] }); // insert

      const res = await withdrawalService.cryptoWithdraw({
        userId: 'user-123',
        asset: 'USDT',
        network: 'ETH',
        amount: '100',
        destinationAddress: '0xabc',
        referenceId: 'ref-123'
      });

      expect(res.id).toBe('withdrawal-123');
      expect(mockAml.validateWithdrawalCompliance).toHaveBeenCalledWith({
        userId: 'user-123',
        asset: 'USDT',
        amount: '100',
        destinationAddress: '0xabc'
      }, mockTxClient);

      expect(mockLedger.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        transactionType: 'WITHDRAWAL',
        entries: [
          { accountId: 'account-123', asset: 'USDT', direction: 'DEBIT', amount: '102.000000000000000000', balancePool: 'available' },
          { accountId: 'account-123', asset: 'USDT', direction: 'CREDIT', amount: '102.000000000000000000', balancePool: 'locked' }
        ]
      }), mockTxClient);
    });

    it('should fail if FUNDING account not found', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-123' }] }) // user row lock
        .mockResolvedValueOnce({ rows: [] }); // account not found

      await expect(withdrawalService.cryptoWithdraw({
        userId: 'user-123', asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: 'ref-123'
      })).rejects.toThrow('FUNDING account not found');
    });

    it('should fail if withdrawal amount is below minimum', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-123' }] }) // user row lock
        .mockResolvedValueOnce({ rows: [{ id: 'account-123', type: 'FUNDING' }] })
        .mockResolvedValueOnce({ rows: [{ is_active: true, min_withdrawal: '200', withdrawal_fee: '2', requires_memo: false }] });

      await expect(withdrawalService.cryptoWithdraw({
        userId: 'user-123', asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: 'ref-123'
      })).rejects.toThrow('below minimum');
    });

    it('should fail if memo required but missing', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'user-123' }] }) // user row lock
        .mockResolvedValueOnce({ rows: [{ id: 'account-123', type: 'FUNDING' }] })
        .mockResolvedValueOnce({ rows: [{ is_active: true, min_withdrawal: '10', withdrawal_fee: '2', requires_memo: true }] });

      await expect(withdrawalService.cryptoWithdraw({
        userId: 'user-123', asset: 'XRP', network: 'XRP', amount: '100', destinationAddress: 'abc', referenceId: 'ref-123'
      })).rejects.toThrow('Destination memo is required');
    });
  });

  describe('Lifecycle and Status', () => {
    it('approveWithdrawalAdmin transitions state to APPROVED', async () => {
      mockTxClient.query.mockResolvedValueOnce({ rows: [{ status: 'PENDING', crypto_status: 'PENDING_REVIEW', user_id: 'user-123' }] });

      await withdrawalService.approveWithdrawalAdmin('withdrawal-123', 'admin-123', 'Ok');

      const updateCall = mockTxClient.query.mock.calls.find((call: any[]) => typeof call[0] === 'string' && call[0].includes('UPDATE withdrawals'));
      expect(updateCall).toBeDefined();

      const sql = updateCall[0];
      const params = updateCall[1];

      expect(sql).toContain("SET crypto_status = 'APPROVED'");
      expect(sql).toContain("reviewed_by = $1");
      expect(sql).toContain("review_reason = COALESCE($2, review_reason)");
      expect(sql).toContain("WHERE id = $3");

      expect(params).toEqual(['admin-123', 'Ok', 'withdrawal-123']);
    });

    it('completeWithdrawal processes SETTLE and FEE', async () => {
      mockTxClient.query.mockResolvedValueOnce({
        rows: [{ id: 'withdrawal-123', account_id: 'account-123', asset: 'USDT', amount: '100', fee: '2', status: 'PENDING' }]
      });

      await withdrawalService.completeWithdrawal('withdrawal-123', '0x123tx');

      expect(mockLedger.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        transactionType: 'WITHDRAWAL_SETTLE',
        entries: [{ accountId: 'account-123', asset: 'USDT', direction: 'DEBIT', amount: '100', balancePool: 'locked' }]
      }), mockTxClient);

      expect(mockLedger.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        transactionType: 'WITHDRAWAL_FEE',
        entries: [
          { accountId: 'account-123', asset: 'USDT', direction: 'DEBIT', amount: '2', balancePool: 'locked' },
          { accountId: '11111111-1111-1111-1111-111111111111', asset: 'USDT', direction: 'CREDIT', amount: '2', balancePool: 'available' }
        ]
      }), mockTxClient);
    });

    it('cancelWithdrawal releases funds', async () => {
      mockTxClient.query.mockResolvedValueOnce({
        rows: [{ id: 'withdrawal-123', account_id: 'account-123', asset: 'USDT', amount: '100', fee: '2', status: 'PENDING', crypto_status: 'APPROVED' }]
      });

      await withdrawalService.cancelWithdrawal('withdrawal-123');

      expect(mockLedger.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        transactionType: 'ADJUSTMENT',
        entries: [
          { accountId: 'account-123', asset: 'USDT', direction: 'DEBIT', amount: '102.000000000000000000', balancePool: 'locked' },
          { accountId: 'account-123', asset: 'USDT', direction: 'CREDIT', amount: '102.000000000000000000', balancePool: 'available' }
        ]
      }), mockTxClient);
    });
  });
});
