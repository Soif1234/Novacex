import { describe, it, expect, beforeEach } from 'vitest';
import { amlService } from '../src/services/compliance/aml.service';
import { kycService } from '../src/services/compliance/kyc.service';
import { walletService } from '../src/services/wallet/wallet.service';
import { authService } from '../src/services/auth/auth.service';

describe('Phase 7.2: AML Sanctions & 24h Rolling Withdrawal Limits Unit Tests', () => {
  let userId: string;
  let accountId: string;
  let reviewerId: string;

  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    await db.connect();

    const userSignup = await authService.signup({
      email: `aml_user_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
      password: 'Password123!Secure',
      username: `tr_aml_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    userId = userSignup.user.id;
    accountId = userSignup.user.accounts.find((a) => a.type === 'SPOT')!.id;

    const reviewerSignup = await authService.signup({
      email: `aml_reviewer_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
      password: 'Password123!Secure',
      username: `rv_aml_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    reviewerId = reviewerSignup.user.id;

    // Credit funds for testing
    await walletService.paperDeposit({
      adminUserId: reviewerId,
      targetAccountId: accountId,
      asset: 'USDT',
      amount: '50000',
      referenceId: `seed-aml-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    });
  });

  it('1. Blocks withdrawal for unverified (Tier 0) users', async () => {
    await expect(
      walletService.paperWithdraw({
        userId,
        accountId,
        asset: 'USDT',
        amount: '100',
        referenceId: `wd-${Date.now()}-1`,
        destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
      })
    ).rejects.toThrow(/Unverified account \(Tier 0\)/);
  });

  it('2. Allows withdrawal within Tier 1 limit (up to 2,000 USDT/24h)', async () => {
    // Complete Tier 1 KYC
    await kycService.submitKyc({
      userId,
      targetTier: 'TIER_1',
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      nationality: 'USA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'P777888',
    });
    await kycService.reviewKyc({
      reviewerId,
      userId,
      approved: true,
      assignedTier: 'TIER_1',
    });

    // Withdraw 500 USDT -> OK
    const receipt = await walletService.paperWithdraw({
      userId,
      accountId,
      asset: 'USDT',
      amount: '500',
      referenceId: `wd-${Date.now()}-2`,
      destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });

    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.amount).toBe('500.000000000000000000');
  });

  it('3. Rejects withdrawal exceeding rolling 24h Tier 1 limit (2,000 USDT total)', async () => {
    // Upgrade to Tier 1
    await kycService.submitKyc({
      userId,
      targetTier: 'TIER_1',
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      nationality: 'USA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'P777888',
    });
    await kycService.reviewKyc({
      reviewerId,
      userId,
      approved: true,
      assignedTier: 'TIER_1',
    });

    // 1st withdrawal: 1,500 USDT (succeeds)
    await walletService.paperWithdraw({
      userId,
      accountId,
      asset: 'USDT',
      amount: '1500',
      referenceId: `wd-${Date.now()}-3a`,
      destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });

    // 2nd withdrawal: 600 USDT (1500 + 600 = 2100 > 2000 limit -> Rejected)
    await expect(
      walletService.paperWithdraw({
        userId,
        accountId,
        asset: 'USDT',
        amount: '600',
        referenceId: `wd-${Date.now()}-3b`,
        destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
      })
    ).rejects.toThrow(/Withdrawal exceeds 24-hour KYC limit/);
  });

  it('4. Upgrading to Tier 2 enables higher withdrawal volume (up to 100,000 USDT/24h)', async () => {
    // Upgrade directly to Tier 2
    await kycService.submitKyc({
      userId,
      targetTier: 'TIER_2',
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      nationality: 'USA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'P777888',
      proofOfAddressUrl: 'https://docs.test/poa.pdf',
    });
    await kycService.reviewKyc({
      reviewerId,
      userId,
      approved: true,
      assignedTier: 'TIER_2',
    });

    // Withdraw 10,000 USDT -> OK (Tier 2 limit is 100,000 USDT)
    const receipt = await walletService.paperWithdraw({
      userId,
      accountId,
      asset: 'USDT',
      amount: '10000',
      referenceId: `wd-${Date.now()}-4`,
      destinationAddress: '0x1234567890abcdef1234567890abcdef12345678',
    });

    expect(receipt.status).toBe('COMPLETED');
    expect(receipt.amount).toBe('10000.000000000000000000');
  });

  it('5. Rejects withdrawal targeting a sanctioned / blacklisted address', async () => {
    const sanctionedAddress = '0xbad0000000000000000000000000000000000001';
    await amlService.addSanctionedAddress(sanctionedAddress, 'OFAC Specially Designated Nationals List', 'OFAC');

    // Upgrade to Tier 2
    await kycService.submitKyc({
      userId,
      targetTier: 'TIER_2',
      firstName: 'Jane',
      lastName: 'Doe',
      dateOfBirth: '1990-01-01',
      nationality: 'USA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'P777888',
      proofOfAddressUrl: 'https://docs.test/poa.pdf',
    });
    await kycService.reviewKyc({
      reviewerId,
      userId,
      approved: true,
      assignedTier: 'TIER_2',
    });

    // Attempt withdrawal to sanctioned address
    await expect(
      walletService.paperWithdraw({
        userId,
        accountId,
        asset: 'USDT',
        amount: '100',
        referenceId: `wd-${Date.now()}-5`,
        destinationAddress: sanctionedAddress,
      })
    ).rejects.toThrow(/flagged on sanctions blacklist/);
  });
});
