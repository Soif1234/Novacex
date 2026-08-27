import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WithdrawalService } from '../src/services/wallet/withdrawal.service';
import { IDatabaseConnection } from '../src/config/database';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { AmlService } from '../src/services/compliance/aml.service';
import { AppError } from '../src/middleware/errorHandler';

describe('WithdrawalService', () => {
  let withdrawalService: WithdrawalService;
  let mockDb: IDatabaseConnection;
  let mockLedger: LedgerService;
  let mockAml: AmlService;
  let mockTxClient: any;

  beforeEach(() => {
    mockTxClient = {
      query: vi.fn(),
    };

    mockDb = {
      query: vi.fn(),
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

  describe('cryptoWithdraw', () => {
    it('should successfully reserve a valid withdrawal from FUNDING account', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'account-123', type: 'FUNDING' }] }) // account
        .mockResolvedValueOnce({ rows: [{ is_active: true, min_withdrawal: '10', withdrawal_fee: '2', requires_memo: false, address_format: 'EVM_HEX' }] }) // network
        .mockResolvedValueOnce({ rows: [{ id: 'withdrawal-123', account_id: 'account-123', asset: 'USDT', network: 'ETH', amount: '100', fee: '2', status: 'PENDING', crypto_status: 'PENDING' }] }); // insert

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
      });

      expect(mockLedger.postTransaction).toHaveBeenCalledWith(expect.objectContaining({
        transactionType: 'WITHDRAWAL',
        entries: [
          { accountId: 'account-123', asset: 'USDT', direction: 'DEBIT', amount: '102.000000000000000000', balancePool: 'available' },
          { accountId: 'account-123', asset: 'USDT', direction: 'CREDIT', amount: '102.000000000000000000', balancePool: 'locked' }
        ]
      }), mockTxClient);
    });

    it('should fail if FUNDING account not found', async () => {
      mockTxClient.query.mockResolvedValueOnce({ rows: [] });

      await expect(withdrawalService.cryptoWithdraw({
        userId: 'user-123', asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: 'ref-123'
      })).rejects.toThrow('FUNDING account not found');
    });

    it('should fail if withdrawal amount is below minimum', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'account-123', type: 'FUNDING' }] })
        .mockResolvedValueOnce({ rows: [{ is_active: true, min_withdrawal: '200', withdrawal_fee: '2', requires_memo: false }] });

      await expect(withdrawalService.cryptoWithdraw({
        userId: 'user-123', asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: 'ref-123'
      })).rejects.toThrow('below minimum');
    });

    it('should fail if memo required but missing', async () => {
      mockTxClient.query
        .mockResolvedValueOnce({ rows: [{ id: 'account-123', type: 'FUNDING' }] })
        .mockResolvedValueOnce({ rows: [{ is_active: true, min_withdrawal: '10', withdrawal_fee: '2', requires_memo: true }] });

      await expect(withdrawalService.cryptoWithdraw({
        userId: 'user-123', asset: 'XRP', network: 'XRP', amount: '100', destinationAddress: 'abc', referenceId: 'ref-123'
      })).rejects.toThrow('Destination memo is required');
    });
  });

  describe('Lifecycle and Status', () => {
    it('approveWithdrawal transitions state to APPROVED', async () => {
      mockTxClient.query.mockResolvedValueOnce({ rows: [{ status: 'PENDING', crypto_status: 'PENDING' }] });
      
      await withdrawalService.approveWithdrawal('withdrawal-123');
      expect(mockTxClient.query).toHaveBeenCalledWith(
        "UPDATE withdrawals SET crypto_status = 'APPROVED', updated_at = NOW() WHERE id = $1",
        ['withdrawal-123']
      );
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
        rows: [{ id: 'withdrawal-123', account_id: 'account-123', asset: 'USDT', amount: '100', fee: '2', status: 'PENDING', crypto_status: 'PENDING' }] 
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
