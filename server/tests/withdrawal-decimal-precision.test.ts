import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WithdrawalService, CryptoWithdrawDto } from '../src/services/wallet/withdrawal.service';
import { decimalCompare, decimalIsPositive, validateAmount } from '../src/services/ledger/decimal';
import { InvalidAmountError } from '../src/services/ledger/errors';
import { AppError } from '../src/middleware/errorHandler';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------
vi.mock('../src/config/env', () => ({
  env: {
    CUSTODY_HOT_WALLET_ADDRESS: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
    CUSTODY_CHAIN_ID: 31337,
    CRYPTO_WITHDRAWALS_ENABLED: true,
  },
}));

vi.mock('../src/config/database', () => ({
  db: { query: vi.fn(), transaction: vi.fn() },
}));

vi.mock('../src/services/wallet/withdrawal-policy.service', () => ({
  withdrawalPolicyService: {
    evaluate: vi.fn().mockResolvedValue({ decision: 'APPROVE', reasons: [] }),
  },
}));

vi.mock('../src/services/custody/custody.service', () => ({
  custodyService: {},
}));

vi.mock('../src/services/custody/manual-tx-verification.service', () => ({
  manualTxVerificationService: {
    verifyWithdrawalTx: vi.fn(),
  },
}));

vi.mock('../src/services/market/event-bus', () => ({
  eventBus: { emit: vi.fn(), publish: vi.fn() },
}));

vi.mock('../src/services/admin/audit.service', () => ({
  auditService: { record: vi.fn() },
}));

describe('PHASE 15D-3: HIGH-01 Withdrawal Decimal Precision Remediation', () => {

  describe('Part 1: IEEE-754 Floating-Point vs. Decimal Arithmetic (Scenario M)', () => {
    it('demonstrates IEEE-754 precision failure where parseFloat permits sub-threshold withdrawal', () => {
      const minWithdrawal = '0.100000000000000001';
      const amount = '0.100000000000000000';

      // Under IEEE-754 double precision, '0.100000000000000001' rounds to 0.1:
      // Therefore parseFloat(amount) < parseFloat(minWithdrawal) is FALSE (0.1 < 0.1 is false)!
      const floatCheck = parseFloat(amount) < parseFloat(minWithdrawal);
      expect(floatCheck).toBe(false); // IEEE-754 precision loss fails to reject sub-minimum!

      // With exact Decimal comparison, decimalCompare correctly detects amount < minWithdrawal:
      const exactComparison = decimalCompare(amount, minWithdrawal);
      expect(exactComparison).toBe(-1); // Correctly identifies amount is strictly below minimum!
    });

    it('demonstrates IEEE-754 equality collapse where distinct 18-decimal values collide', () => {
      const valA = '1.00000000000000005';
      const valB = '1.00000000000000006';

      // In IEEE-754 double precision, both values round to the identical float:
      expect(parseFloat(valA) === parseFloat(valB)).toBe(true);

      // In exact Decimal arithmetic, they are strictly distinct:
      expect(decimalCompare(valA, valB)).toBe(-1);
    });
  });

  describe('Part 2: Decimal Utilities Boundary Verification', () => {
    // Test A: amount == minWithdrawal
    it('Scenario A: amount == minWithdrawal ("0.01" == "0.010000000000000000") evaluates to 0 (equal)', () => {
      expect(decimalCompare('0.01', '0.010000000000000000')).toBe(0);
    });

    // Test B: amount < minWithdrawal by 10^-18
    it('Scenario B: amount < minWithdrawal by 10^-18 evaluates to -1 (strictly below)', () => {
      expect(decimalCompare('0.100000000000000000', '0.100000000000000001')).toBe(-1);
    });

    // Test C: amount > minWithdrawal by 10^-18
    it('Scenario C: amount > minWithdrawal by 10^-18 evaluates to 1 (strictly above)', () => {
      expect(decimalCompare('0.100000000000000001', '0.100000000000000000')).toBe(1);
    });

    // Test D: 18-decimal ETH value (1 wei)
    it('Scenario D: 18-decimal ETH value "0.000000000000000001" is valid and positive', () => {
      expect(() => validateAmount('0.000000000000000001')).not.toThrow();
      expect(decimalIsPositive('0.000000000000000001')).toBe(true);
      expect(decimalCompare('0.000000000000000001', '0.000000000000000001')).toBe(0);
    });

    // Test E: 18-decimal ERC20 value
    it('Scenario E: 18-decimal ERC20 value "100.123456789012345678" is valid and compared accurately', () => {
      expect(() => validateAmount('100.123456789012345678')).not.toThrow();
      expect(decimalCompare('100.123456789012345678', '100.123456789012345677')).toBe(1);
      expect(decimalCompare('100.123456789012345678', '100.123456789012345679')).toBe(-1);
    });

    // Test F: Micro-fee greater than zero
    it('Scenario F: Micro-fee "0.000000000000000001" evaluates to positive', () => {
      expect(decimalIsPositive('0.000000000000000001')).toBe(true);
    });

    // Test G: Fee exactly zero
    it('Scenario G: Fee "0" and "0.000000000000000000" evaluate to NOT positive', () => {
      expect(decimalIsPositive('0')).toBe(false);
      expect(decimalIsPositive('0.000000000000000000')).toBe(false);
    });

    // Test H: Large valid amount
    it('Scenario H: Large valid amount "999999999999999999.999999999999999999" compares without overflow', () => {
      const large = '999999999999999999.999999999999999999';
      expect(() => validateAmount(large)).not.toThrow();
      expect(decimalCompare(large, '1.0')).toBe(1);
      expect(decimalCompare(large, large)).toBe(0);
    });

    // Test I: Maximum 18-decimal precision amount
    it('Scenario I: Maximum 18-decimal precision amount is preserved exactly', () => {
      const maxPrec = '123456789.987654321012345678';
      expect(decimalCompare(maxPrec, '123456789.987654321012345677')).toBe(1);
    });

    // Test J: Malformed numeric strings
    it('Scenario J: Malformed strings ("not_a_number", "1.2.3") are rejected by validateAmount', () => {
      expect(() => validateAmount('not_a_number')).toThrow(InvalidAmountError);
      expect(() => validateAmount('1.2.3')).toThrow(InvalidAmountError);
      expect(() => validateAmount('')).toThrow(InvalidAmountError);
      expect(() => validateAmount('NaN')).toThrow(InvalidAmountError);
      expect(() => validateAmount('Infinity')).toThrow(InvalidAmountError);
    });

    // Test K: Negative amount
    it('Scenario K: Negative amount "-0.5" is rejected by validateAmount', () => {
      expect(() => validateAmount('-0.5')).toThrow(InvalidAmountError);
      expect(() => validateAmount('-0.000000000000000001')).toThrow(InvalidAmountError);
    });

    // Test L: Scientific notation
    it('Scenario L: Scientific notation "1e-5" is rejected by validateAmount', () => {
      expect(() => validateAmount('1e-5')).toThrow(InvalidAmountError);
      expect(() => validateAmount('1E18')).toThrow(InvalidAmountError);
    });
  });

  describe('Part 3: WithdrawalService.cryptoWithdraw Minimum Check Integration', () => {
    let service: WithdrawalService;
    let mockTxClient: any;
    let mockDb: any;
    let mockLedger: any;
    let mockAml: any;

    const baseDto: CryptoWithdrawDto = {
      userId: 'user-uuid-1',
      asset: 'ETH',
      network: 'ETHEREUM',
      amount: '0.1',
      destinationAddress: '0x1111111111111111111111111111111111111111',
      referenceId: 'ref-test-1',
    };

    function setupMocks(minWithdrawal: string, withdrawalFee: string = '0.001') {
      mockTxClient = {
        query: vi.fn(async (sql: string, params?: any[]) => {
          if (sql.includes('SELECT id FROM users WHERE id = $1 FOR UPDATE')) {
            return { rows: [{ id: 'user-uuid-1' }] };
          }
          if (sql.includes('SELECT id, type FROM accounts WHERE user_id = $1')) {
            return { rows: [{ id: 'acc-uuid-1', type: 'FUNDING' }] };
          }
          if (sql.includes('SELECT * FROM asset_networks')) {
            return {
              rows: [{
                asset: 'ETH',
                network: 'ETHEREUM',
                is_active: true,
                min_withdrawal: minWithdrawal,
                withdrawal_fee: withdrawalFee,
                requires_memo: false,
                address_format: 'EVM_HEX',
              }],
            };
          }
          if (sql.includes('INSERT INTO withdrawals')) {
            return {
              rows: [{
                id: 'wid-123',
                user_id: 'user-uuid-1',
                account_id: 'acc-uuid-1',
                asset: 'ETH',
                network: 'ETHEREUM',
                amount: params?.[3] ?? '0.1',
                fee: withdrawalFee,
                status: 'PENDING',
                crypto_status: 'APPROVED',
              }],
            };
          }
          return { rows: [] };
        }),
      };

      mockDb = {
        transaction: vi.fn(async (cb: any) => await cb(mockTxClient)),
        query: vi.fn().mockResolvedValue({ rows: [{ email: 'user@example.com' }] }),
      };

      mockLedger = {
        lock: vi.fn().mockResolvedValue(undefined),
        postTransaction: vi.fn().mockResolvedValue({ transactionId: 'ltx-123' }),
      };

      mockAml = {
        validateWithdrawalCompliance: vi.fn().mockResolvedValue(undefined),
      };

      service = new WithdrawalService(mockDb as any, mockLedger as any, mockAml as any);
    }

    it('Scenario A in Service: accepts withdrawal when amount exactly equals min_withdrawal', async () => {
      setupMocks('0.010000000000000000');
      const result = await service.cryptoWithdraw({
        ...baseDto,
        amount: '0.01',
      });
      expect(result).toBeDefined();
      expect(result.id).toBe('wid-123');
    });

    it('Scenario B in Service: rejects withdrawal when amount is 10^-18 below min_withdrawal (IEEE-754 precision boundary)', async () => {
      setupMocks('0.100000000000000001'); // min is slightly above 0.1
      await expect(
        service.cryptoWithdraw({
          ...baseDto,
          amount: '0.100000000000000000', // 10^-18 below minimum
        })
      ).rejects.toThrowError(
        expect.objectContaining({
          message: expect.stringContaining('Withdrawal amount is below minimum of 0.100000000000000001'),
          code: 'BELOW_MINIMUM',
          statusCode: 400,
        })
      );
    });

    it('Scenario C in Service: accepts withdrawal when amount is 10^-18 above min_withdrawal', async () => {
      setupMocks('0.100000000000000000');
      const result = await service.cryptoWithdraw({
        ...baseDto,
        amount: '0.100000000000000001',
      });
      expect(result).toBeDefined();
      expect(result.id).toBe('wid-123');
    });

    it('Scenario D in Service: accepts 18-decimal minimum withdrawal of 1 wei', async () => {
      setupMocks('0.000000000000000001');
      const result = await service.cryptoWithdraw({
        ...baseDto,
        amount: '0.000000000000000001',
      });
      expect(result).toBeDefined();
    });

    it('Scenario E in Service: accepts 18-decimal ERC20 amount above minimum', async () => {
      setupMocks('1.0');
      const result = await service.cryptoWithdraw({
        ...baseDto,
        asset: 'USDC',
        amount: '100.123456789012345678',
      });
      expect(result).toBeDefined();
    });

    it('Scenario H in Service: accepts large valid 18-decimal amount without overflow', async () => {
      setupMocks('1.0');
      const result = await service.cryptoWithdraw({
        ...baseDto,
        amount: '999999999999999999.999999999999999999',
      });
      expect(result).toBeDefined();
    });

    it('Scenario J in Service: rejects malformed amount before DB query', async () => {
      setupMocks('0.01');
      await expect(
        service.cryptoWithdraw({
          ...baseDto,
          amount: 'not_a_number',
        })
      ).rejects.toThrow(InvalidAmountError);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('Scenario K in Service: rejects negative amount before DB query', async () => {
      setupMocks('0.01');
      await expect(
        service.cryptoWithdraw({
          ...baseDto,
          amount: '-1.0',
        })
      ).rejects.toThrow(InvalidAmountError);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('Scenario L in Service: rejects scientific notation before DB query', async () => {
      setupMocks('0.01');
      await expect(
        service.cryptoWithdraw({
          ...baseDto,
          amount: '1e-5',
        })
      ).rejects.toThrow(InvalidAmountError);
      expect(mockDb.transaction).not.toHaveBeenCalled();
    });
  });

  describe('Part 4: Withdrawal Settlement Fee Handling (Scenarios F & G)', () => {
    let service: WithdrawalService;
    let mockTxClient: any;
    let mockDb: any;
    let mockLedger: any;

    function setupSettlementMocks(withdrawalFee: string) {
      mockTxClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('SELECT * FROM withdrawals WHERE id = $1 FOR UPDATE')) {
            return {
              rows: [{
                id: 'wid-settle-1',
                account_id: 'acc-uuid-1',
                user_id: 'user-uuid-1',
                asset: 'ETH',
                amount: '1.0',
                fee: withdrawalFee,
                status: 'PENDING',
              }],
            };
          }
          if (sql.includes('UPDATE withdrawals')) {
            return { rows: [], rowCount: 1 };
          }
          return { rows: [] };
        }),
      };

      mockDb = {
        transaction: vi.fn(async (cb: any) => await cb(mockTxClient)),
      };

      mockLedger = {
        postTransaction: vi.fn().mockResolvedValue(undefined),
      };

      service = new WithdrawalService(mockDb as any, mockLedger as any, {} as any);
    }

    it('Scenario F: posts fee transaction when fee is a micro-fee > 0 ("0.000000000000000001")', async () => {
      setupSettlementMocks('0.000000000000000001');
      await service.completeWithdrawal('wid-settle-1', '0x' + 'aa'.repeat(32));

      expect(mockLedger.postTransaction).toHaveBeenCalledTimes(2);

      // Settle transaction
      expect(mockLedger.postTransaction).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          transactionType: 'WITHDRAWAL_SETTLE',
          entries: [
            { accountId: 'acc-uuid-1', asset: 'ETH', direction: 'DEBIT', amount: '1.0', balancePool: 'locked' },
          ],
        }),
        mockTxClient
      );

      // Fee transaction
      expect(mockLedger.postTransaction).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          transactionType: 'WITHDRAWAL_FEE',
          entries: [
            { accountId: 'acc-uuid-1', asset: 'ETH', direction: 'DEBIT', amount: '0.000000000000000001', balancePool: 'locked' },
            { accountId: '11111111-1111-1111-1111-111111111111', asset: 'ETH', direction: 'CREDIT', amount: '0.000000000000000001', balancePool: 'available' },
          ],
        }),
        mockTxClient
      );
    });

    it('Scenario G1: does NOT post fee transaction when fee is "0"', async () => {
      setupSettlementMocks('0');
      await service.completeWithdrawal('wid-settle-1', '0x' + 'aa'.repeat(32));

      // Settle transaction only, NO fee transaction
      expect(mockLedger.postTransaction).toHaveBeenCalledTimes(1);
      expect(mockLedger.postTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'WITHDRAWAL_SETTLE',
        }),
        mockTxClient
      );
    });

    it('Scenario G2: does NOT post fee transaction when fee is "0.000000000000000000"', async () => {
      setupSettlementMocks('0.000000000000000000');
      await service.completeWithdrawal('wid-settle-1', '0x' + 'aa'.repeat(32));

      // Settle transaction only, NO fee transaction
      expect(mockLedger.postTransaction).toHaveBeenCalledTimes(1);
      expect(mockLedger.postTransaction).toHaveBeenCalledWith(
        expect.objectContaining({
          transactionType: 'WITHDRAWAL_SETTLE',
        }),
        mockTxClient
      );
    });
  });
});
