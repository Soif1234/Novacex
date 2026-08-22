import { describe, it, expect, beforeEach } from 'vitest';
import { kycService } from '../src/services/compliance/kyc.service';
import { authService } from '../src/services/auth/auth.service';

describe('Phase 7.2: KYC Identity Verification & Review Unit Tests', () => {
  let userId: string;
  let reviewerId: string;

  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    await db.connect();

    const userSignup = await authService.signup({
      email: `trader_kyc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
      password: 'Password123!Secure',
      username: `trkyc_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    userId = userSignup.user.id;

    const reviewerSignup = await authService.signup({
      email: `compliance_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@test.com`,
      password: 'Password123!Secure',
      username: `comp_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`,
    });
    reviewerId = reviewerSignup.user.id;
  });

  it('1. Default KYC profile is TIER_0 and UNVERIFIED', async () => {
    const profile = await kycService.getProfile(userId);
    expect(profile.tier).toBe('TIER_0');
    expect(profile.status).toBe('UNVERIFIED');
  });

  it('2. Submits valid Tier 1 KYC and enters PENDING_REVIEW state', async () => {
    const submitted = await kycService.submitKyc({
      userId,
      targetTier: 'TIER_1',
      firstName: 'Alice',
      lastName: 'Smith',
      dateOfBirth: '1995-05-15',
      nationality: 'USA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'P12345678',
      idDocumentFrontUrl: 'https://docs.test/front.jpg',
    });

    expect(submitted.status).toBe('PENDING_REVIEW');
    expect(submitted.firstName).toBe('Alice');
    expect(submitted.lastName).toBe('Smith');
    expect(submitted.nationality).toBe('USA');
    expect(submitted.submittedAt).toBeDefined();

    const profile = await kycService.getProfile(userId);
    expect(profile.status).toBe('PENDING_REVIEW');
  });

  it('3. Rejects submission for underage users (< 18)', async () => {
    const nextYear = new Date().getFullYear() - 15;
    await expect(
      kycService.submitKyc({
        userId,
        targetTier: 'TIER_1',
        firstName: 'Underage',
        lastName: 'User',
        dateOfBirth: `${nextYear}-01-01`,
        nationality: 'USA',
        idDocumentType: 'PASSPORT',
        idDocumentNumber: 'P00000000',
      })
    ).rejects.toThrow(/must be at least 18 years of age/);
  });

  it('4. Tier 2 requires proof of address', async () => {
    await expect(
      kycService.submitKyc({
        userId,
        targetTier: 'TIER_2',
        firstName: 'Bob',
        lastName: 'Jones',
        dateOfBirth: '1990-01-01',
        nationality: 'GBR',
        idDocumentType: 'DRIVERS_LICENSE',
        idDocumentNumber: 'DL999999',
      })
    ).rejects.toThrow(/Proof of address is required for Tier 2/);
  });

  it('5. Approves KYC submission and upgrades user to TIER_1', async () => {
    await kycService.submitKyc({
      userId,
      targetTier: 'TIER_1',
      firstName: 'Charlie',
      lastName: 'Brown',
      dateOfBirth: '1988-11-20',
      nationality: 'CAN',
      idDocumentType: 'NATIONAL_ID',
      idDocumentNumber: 'NID55555',
    });

    const reviewed = await kycService.reviewKyc({
      reviewerId,
      userId,
      approved: true,
      assignedTier: 'TIER_1',
    });

    expect(reviewed.status).toBe('VERIFIED');
    expect(reviewed.tier).toBe('TIER_1');
    expect(reviewed.reviewerId).toBe(reviewerId);
    expect(reviewed.verifiedAt).toBeDefined();

    const profile = await kycService.getProfile(userId);
    expect(profile.status).toBe('VERIFIED');
    expect(profile.tier).toBe('TIER_1');
  });

  it('6. Rejects KYC submission with feedback reason', async () => {
    await kycService.submitKyc({
      userId,
      targetTier: 'TIER_1',
      firstName: 'Dan',
      lastName: 'Miller',
      dateOfBirth: '1992-07-07',
      nationality: 'FRA',
      idDocumentType: 'PASSPORT',
      idDocumentNumber: 'FP123456',
    });

    const rejected = await kycService.reviewKyc({
      reviewerId,
      userId,
      approved: false,
      rejectionReason: 'ID image is blurry and illegible',
    });

    expect(rejected.status).toBe('REJECTED');
    expect(rejected.tier).toBe('TIER_0');
    expect(rejected.rejectionReason).toBe('ID image is blurry and illegible');
  });
});
