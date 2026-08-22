export type KycTier = 'TIER_0' | 'TIER_1' | 'TIER_2';
export type KycStatus = 'UNVERIFIED' | 'PENDING_REVIEW' | 'VERIFIED' | 'REJECTED';
export type IdDocumentType = 'PASSPORT' | 'DRIVERS_LICENSE' | 'NATIONAL_ID';

export const KYC_TIER_DAILY_LIMITS: Record<KycTier, string> = {
  TIER_0: '0.000000000000000000',
  TIER_1: '2000.000000000000000000',
  TIER_2: '100000.000000000000000000',
};

export interface UserKycProfileEntity {
  id: string;
  userId: string;
  tier: KycTier;
  status: KycStatus;
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string;
  nationality?: string;
  idDocumentType?: IdDocumentType;
  idDocumentNumber?: string;
  idDocumentFrontUrl?: string;
  idDocumentBackUrl?: string;
  proofOfAddressUrl?: string;
  rejectionReason?: string;
  reviewerId?: string;
  submittedAt?: Date;
  verifiedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface SubmitKycDto {
  userId: string;
  targetTier: 'TIER_1' | 'TIER_2';
  firstName: string;
  lastName: string;
  dateOfBirth: string; // YYYY-MM-DD
  nationality: string; // ISO 3166-1 alpha-3 (3 uppercase chars)
  idDocumentType: IdDocumentType;
  idDocumentNumber: string;
  idDocumentFrontUrl?: string;
  idDocumentBackUrl?: string;
  proofOfAddressUrl?: string; // Required for TIER_2
}

export interface ReviewKycDto {
  reviewerId: string;
  userId: string;
  approved: boolean;
  assignedTier?: KycTier;
  rejectionReason?: string;
}

export interface KycStatusResponse {
  userId: string;
  tier: KycTier;
  status: KycStatus;
  dailyLimit: string;
  usedDailyLimit: string;
  remainingDailyLimit: string;
  rejectionReason?: string;
  submittedAt?: Date;
  verifiedAt?: Date;
}

export interface SanctionedAddressEntity {
  id: string;
  address: string;
  asset: string;
  reason: string;
  source: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}
