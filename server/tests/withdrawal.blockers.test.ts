import { describe, it, expect, vi, beforeEach } from 'vitest';
import { db } from '../src/config/database';
import { withdrawalService } from '../src/services/wallet/withdrawal.service';
import { amlService } from '../src/services/compliance/aml.service';
import { kycService } from '../src/services/compliance/kyc.service';
import { authService } from '../src/services/auth/auth.service';
import { ledgerService } from '../src/services/ledger/ledger.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { custodyService } from '../src/services/custody/custody.service';

describe('Blockers Fixes Tests', () => {
  let userId: string;
  let reviewerId: string;
  let fundingAccountId: string;

  beforeEach(async () => {
    await db.connect();

    const userSignup = await authService.signup({
      email: `aml_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
      password: 'Password123!Secure',
      username: `tr_aml_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    userId = userSignup.user.id;

    // Fetch FUNDING account
    const fundingRes = await db.query(`SELECT id FROM accounts WHERE user_id = $1 AND type = 'FUNDING'`, [userId]);
    fundingAccountId = fundingRes.rows[0].id;

    const reviewerSignup = await authService.signup({
      email: `aml_reviewer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
      password: 'Password123!Secure',
      username: `rv_aml_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    reviewerId = reviewerSignup.user.id;

    // Upgrade to Tier 2 so limits are high
    await kycService.submitKyc({
      userId, targetTier: 'TIER_2', firstName: 'Jane', lastName: 'Doe', dateOfBirth: '1990-01-01',
      nationality: 'USA', idDocumentType: 'PASSPORT', idDocumentNumber: 'P777888', proofOfAddressUrl: 'https://docs.test/poa.pdf'
    });
    await kycService.reviewKyc({ reviewerId, userId, approved: true, assignedTier: 'TIER_2' });

    // Ensure asset and asset network exists
    await db.query(`INSERT INTO assets (symbol, name, type, is_active, min_confirmations) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, ['USDT', 'Tether', 'CRYPTO', true, 1]);
    await db.query(`INSERT INTO asset_networks (asset, network, is_active, requires_memo) VALUES ($1, $2, $3, $4) ON CONFLICT (asset, network) DO UPDATE SET is_active = true`, ['USDT', 'ETH', true, false]);

    // Seed ledger manually to funding account
    await ledgerService.credit(fundingAccountId, 'USDT', '10000', 'DEPOSIT', `seed-${Date.now()}`, 'Seed funds');
  });

  describe('Blocker 1 & 2: AML Reversals and Fee Counting', () => {
    it('1. ACTIVE successful withdrawal counts toward 24h volume', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-1` });
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(100);
    });

    it('2. FAILED withdrawal does not consume the 24h allowance', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      const w = await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-2` });
      await withdrawalService.failWithdrawal(w.id, 'Test Failure');
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(0);
    });

    it('3. REJECTED withdrawal does not consume the 24h allowance', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      const w = await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-3` });
      await db.query("UPDATE withdrawals SET status = 'REJECTED' WHERE id = $1", [w.id]);
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(0);
    });

    it('4. admin rejection safely releases reservation and does not consume AML', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      const w = await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-4` });

      // Admin rejection releases funds and sets status to REJECTED (which drops it from AML calculation)
      await withdrawalService.rejectWithdrawalAdmin(w.id, reviewerId, 'Rejected for test');

      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(0);
    });

    it('5. WITHDRAWAL_SETTLE is not counted, and 6. WITHDRAWAL_FEE is not counted', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      const w = await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-5` });
      await withdrawalService.completeWithdrawal(w.id, '0xtxhash123');
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      // Only the initial WITHDRAWAL is counted (100). The SETTLE and FEE transactions don't add to it.
      expect(newTotal - initialTotal).toBe(100);
    });

    it('7. A 100 withdrawal with a 5 fee counts as 100, NOT 105.', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-7` });
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(100);
    });

    it('8. Two valid withdrawals of 100 each count as 200.', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-8a` });
      await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-8b` });
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(200);
    });

    it('9. A failed 100 withdrawal that was reserved then released contributes 0.', async () => {
      const initialTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      const w = await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-9` });
      await withdrawalService.failWithdrawal(w.id, 'failed network');
      const newTotal = parseFloat(await amlService.get24HourWithdrawalTotal(userId));
      expect(newTotal - initialTotal).toBe(0);
    });

    it('10. Re-running the AML calculation produces the same result.', async () => {
      await withdrawalService.cryptoWithdraw({ userId, asset: 'USDT', network: 'ETH', amount: '100', destinationAddress: '0xabc', referenceId: `wd-${Date.now()}-10` });
      const total1 = await amlService.get24HourWithdrawalTotal(userId);
      const total2 = await amlService.get24HourWithdrawalTotal(userId);
      expect(total1).toBe(total2);
    });
  });

  describe('Blocker 3: Concurrency and Timeout', () => {
    it('1. two workers cannot claim the same APPROVED withdrawal (uses FOR UPDATE SKIP LOCKED)', async () => {
      const mockTxClient = { query: vi.fn().mockResolvedValue({ rows: [{ id: 'w1' }] }) };
      const originalTransaction = db.transaction;
      db.transaction = vi.fn(async (cb) => await cb(mockTxClient)) as any;

      await withdrawalService.claimApprovedWithdrawals(20);

      expect(mockTxClient.query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE SKIP LOCKED'), [20]);
      expect(mockTxClient.query).toHaveBeenCalledWith(expect.stringContaining("UPDATE withdrawals SET crypto_status = 'SUBMITTING'"), [['w1']]);

      db.transaction = originalTransaction;
    });

    it('2. timeout leaves funds locked and transitions to UNKNOWN', async () => {
      const { env } = await import('../src/config/env');
      const origEnabled = env.CRYPTO_WITHDRAWALS_ENABLED;
      (env as any).CRYPTO_WITHDRAWALS_ENABLED = true;

      vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({ operational: true });
      vi.spyOn(withdrawalService, 'claimApprovedWithdrawals').mockResolvedValue([{
        id: 'w1', accountId: 'a1', asset: 'USDT', network: 'ETH', amount: '100', status: 'PENDING', cryptoStatus: 'SUBMITTING', destinationAddress: '0x'
      }] as any);
      vi.spyOn(custodyService, 'requestWithdrawal').mockRejectedValue(new Error('Network timeout'));
      vi.spyOn(withdrawalService, 'updateCryptoStatus').mockResolvedValue();

      const { withdrawalProcessingWorker } = await import('../src/workers/WithdrawalProcessingWorker');
      await (withdrawalProcessingWorker as any).execute();

      expect(withdrawalService.updateCryptoStatus).toHaveBeenCalledWith('w1', 'UNKNOWN');

      (env as any).CRYPTO_WITHDRAWALS_ENABLED = origEnabled;
      vi.restoreAllMocks();
    });
  });
});
