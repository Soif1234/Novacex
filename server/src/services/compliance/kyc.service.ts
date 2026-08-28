import { NotificationEventType, KycApprovedEvent } from '../notification/notification.types';
import { eventBus } from '../market/event-bus';
import { db, IDatabaseConnection } from '../../config/database';
import {
  KycTier,
  KycStatus,
  SubmitKycDto,
  ReviewKycDto,
  UserKycProfileEntity,
  KYC_TIER_DAILY_LIMITS,
} from '../../models/kyc.model';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export class KycService {
  constructor(private database: IDatabaseConnection = db) {}

  /**
   * Get or initialize a user's KYC profile
   */
  public async getProfile(userId: string): Promise<UserKycProfileEntity> {
    const res = await this.database.query<any>(
      `SELECT id, user_id AS "userId", tier, status, first_name AS "firstName", last_name AS "lastName",
              date_of_birth AS "dateOfBirth", nationality, id_document_type AS "idDocumentType",
              id_document_number AS "idDocumentNumber", id_document_front_url AS "idDocumentFrontUrl",
              id_document_back_url AS "idDocumentBackUrl", proof_of_address_url AS "proofOfAddressUrl",
              rejection_reason AS "rejectionReason", reviewer_id AS "reviewerId",
              submitted_at AS "submittedAt", verified_at AS "verifiedAt",
              created_at AS "createdAt", updated_at AS "updatedAt"
       FROM user_kyc_profiles
       WHERE user_id = $1`,
      [userId]
    );

    if (res.rows.length > 0) {
      return res.rows[0];
    }

    // Default TIER_0 unverified profile
    return {
      id: '',
      userId,
      tier: 'TIER_0',
      status: 'UNVERIFIED',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  }

  /**
   * Submit KYC verification details for review
   */
  public async submitKyc(dto: SubmitKycDto): Promise<UserKycProfileEntity> {
    // 1. Validation
    if (!dto.firstName || !dto.firstName.trim()) {
      throw new AppError('First name is required', 400, 'INVALID_FIRST_NAME');
    }
    if (!dto.lastName || !dto.lastName.trim()) {
      throw new AppError('Last name is required', 400, 'INVALID_LAST_NAME');
    }
    if (!dto.dateOfBirth || isNaN(Date.parse(dto.dateOfBirth))) {
      throw new AppError('Valid date of birth (YYYY-MM-DD) is required', 400, 'INVALID_DOB');
    }

    // Check age >= 18
    const birthDate = new Date(dto.dateOfBirth);
    const ageDiffMs = Date.now() - birthDate.getTime();
    const ageYears = ageDiffMs / (1000 * 60 * 60 * 24 * 365.25);
    if (ageYears < 18) {
      throw new AppError('You must be at least 18 years of age to pass KYC verification', 400, 'UNDERAGE_KYC');
    }

    if (!dto.nationality || dto.nationality.trim().length !== 3) {
      throw new AppError('Nationality must be a 3-letter ISO code (e.g. USA, GBR, IND)', 400, 'INVALID_NATIONALITY');
    }

    const validDocTypes = ['PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID'];
    if (!validDocTypes.includes(dto.idDocumentType)) {
      throw new AppError('Invalid ID document type', 400, 'INVALID_DOCUMENT_TYPE');
    }

    if (!dto.idDocumentNumber || !dto.idDocumentNumber.trim()) {
      throw new AppError('ID document number is required', 400, 'INVALID_DOCUMENT_NUMBER');
    }

    if (dto.targetTier === 'TIER_2' && (!dto.proofOfAddressUrl || !dto.proofOfAddressUrl.trim())) {
      throw new AppError('Proof of address is required for Tier 2 verification', 400, 'MISSING_PROOF_OF_ADDRESS');
    }

    const nationality = dto.nationality.trim().toUpperCase();

    // 2. Insert or update profile
    const existing = await this.database.query<any>(
      'SELECT id, status FROM user_kyc_profiles WHERE user_id = $1',
      [dto.userId]
    );

    let row: any;
    if (existing.rows.length === 0) {
      const insertRes = await this.database.query<any>(
        `INSERT INTO user_kyc_profiles (
          user_id, tier, status, first_name, last_name, date_of_birth, nationality,
          id_document_type, id_document_number, id_document_front_url, id_document_back_url,
          proof_of_address_url, submitted_at, updated_at
        ) VALUES ($1, 'TIER_0', 'PENDING_REVIEW', $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW(), NOW())
        RETURNING id, user_id AS "userId", tier, status, first_name AS "firstName", last_name AS "lastName",
                  date_of_birth AS "dateOfBirth", nationality, id_document_type AS "idDocumentType",
                  id_document_number AS "idDocumentNumber", id_document_front_url AS "idDocumentFrontUrl",
                  id_document_back_url AS "idDocumentBackUrl", proof_of_address_url AS "proofOfAddressUrl",
                  submitted_at AS "submittedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          dto.userId,
          dto.firstName.trim(),
          dto.lastName.trim(),
          dto.dateOfBirth,
          nationality,
          dto.idDocumentType,
          dto.idDocumentNumber.trim(),
          dto.idDocumentFrontUrl || null,
          dto.idDocumentBackUrl || null,
          dto.proofOfAddressUrl || null,
        ]
      );
      row = insertRes.rows[0];
    } else {
      const updateRes = await this.database.query<any>(
        `UPDATE user_kyc_profiles
         SET status = 'PENDING_REVIEW', first_name = $1, last_name = $2, date_of_birth = $3,
             nationality = $4, id_document_type = $5, id_document_number = $6,
             id_document_front_url = $7, id_document_back_url = $8, proof_of_address_url = $9,
             rejection_reason = NULL, submitted_at = NOW(), updated_at = NOW()
         WHERE user_id = $10
         RETURNING id, user_id AS "userId", tier, status, first_name AS "firstName", last_name AS "lastName",
                   date_of_birth AS "dateOfBirth", nationality, id_document_type AS "idDocumentType",
                   id_document_number AS "idDocumentNumber", id_document_front_url AS "idDocumentFrontUrl",
                   id_document_back_url AS "idDocumentBackUrl", proof_of_address_url AS "proofOfAddressUrl",
                   submitted_at AS "submittedAt", created_at AS "createdAt", updated_at AS "updatedAt"`,
        [
          dto.firstName.trim(),
          dto.lastName.trim(),
          dto.dateOfBirth,
          nationality,
          dto.idDocumentType,
          dto.idDocumentNumber.trim(),
          dto.idDocumentFrontUrl || null,
          dto.idDocumentBackUrl || null,
          dto.proofOfAddressUrl || null,
          dto.userId,
        ]
      );
      row = updateRes.rows[0];
    }

    logger.info('KYC submission received', { userId: dto.userId, targetTier: dto.targetTier });
    return row;
  }

  /**
   * Compliance review: Approve or reject KYC profile
   */
  public async reviewKyc(dto: ReviewKycDto): Promise<UserKycProfileEntity> {
    const existing = await this.database.query<any>(
      'SELECT id, status FROM user_kyc_profiles WHERE user_id = $1',
      [dto.userId]
    );

    if (existing.rows.length === 0) {
      throw new AppError('No KYC submission found for this user', 404, 'KYC_NOT_FOUND');
    }

    let updateRes: any;
    if (dto.approved) {
      const assignedTier: KycTier = dto.assignedTier || 'TIER_1';
      updateRes = await this.database.query<any>(
        `UPDATE user_kyc_profiles
         SET status = 'VERIFIED', tier = $1, reviewer_id = $2, rejection_reason = NULL,
             verified_at = NOW(), updated_at = NOW()
         WHERE user_id = $3
         RETURNING id, user_id AS "userId", tier, status, first_name AS "firstName", last_name AS "lastName",
                   date_of_birth AS "dateOfBirth", nationality, id_document_type AS "idDocumentType",
                   id_document_number AS "idDocumentNumber", reviewer_id AS "reviewerId",
                   verified_at AS "verifiedAt", submitted_at AS "submittedAt",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [assignedTier, dto.reviewerId, dto.userId]
      );
      logger.info('KYC submission approved', { userId: dto.userId, tier: assignedTier, reviewerId: dto.reviewerId });

      const uRes = await this.database.query<any>('SELECT email FROM users WHERE id = $1', [dto.userId]);
      if (uRes.rows.length > 0) {
        eventBus.publish({
          id: "", timestamp: Date.now(), version: "1.0.0", type: NotificationEventType.KYC_APPROVED,
          payload: {
            userId: dto.userId,
            email: uRes.rows[0].email,
            tier: assignedTier
          }
        });
      }
    } else {
      if (!dto.rejectionReason || !dto.rejectionReason.trim()) {
        throw new AppError('Rejection reason is required when rejecting KYC', 400, 'MISSING_REJECTION_REASON');
      }

      updateRes = await this.database.query<any>(
        `UPDATE user_kyc_profiles
         SET status = 'REJECTED', tier = 'TIER_0', reviewer_id = $1, rejection_reason = $2,
             updated_at = NOW()
         WHERE user_id = $3
         RETURNING id, user_id AS "userId", tier, status, first_name AS "firstName", last_name AS "lastName",
                   date_of_birth AS "dateOfBirth", nationality, id_document_type AS "idDocumentType",
                   id_document_number AS "idDocumentNumber", rejection_reason AS "rejectionReason",
                   reviewer_id AS "reviewerId", submitted_at AS "submittedAt",
                   created_at AS "createdAt", updated_at AS "updatedAt"`,
        [dto.reviewerId, dto.rejectionReason.trim(), dto.userId]
      );
      logger.info('KYC submission rejected', { userId: dto.userId, reason: dto.rejectionReason, reviewerId: dto.reviewerId });
    }

    return updateRes.rows[0];
  }
}

export const kycService = new KycService();
