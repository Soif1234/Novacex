import { Request, Response, NextFunction } from 'express';
import { kycService } from '../services/compliance/kyc.service';
import { amlService } from '../services/compliance/aml.service';
import { KYC_TIER_DAILY_LIMITS, KycTier, KycStatusResponse } from '../models/kyc.model';
import { decimalSubtract, decimalCompare } from '../services/ledger/decimal';
import { AppError } from '../middleware/errorHandler';

export class KycController {
  /**
   * GET /api/v1/kyc/status
   * Returns current user's KYC tier, verification status, and remaining 24h limits.
   */
  public static async getKycStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const profile = await kycService.getProfile(req.user.id);
      const tier: KycTier = profile.status === 'VERIFIED' ? profile.tier : 'TIER_0';
      const dailyLimit = KYC_TIER_DAILY_LIMITS[tier] || '0.000000000000000000';
      const usedDailyLimit = await amlService.get24HourWithdrawalTotal(req.user.id);

      const rem = decimalSubtract(dailyLimit, usedDailyLimit);
      const remainingDailyLimit = decimalCompare(rem, '0') > 0 ? rem : '0.000000000000000000';

      const response: KycStatusResponse = {
        userId: req.user.id,
        tier: profile.tier,
        status: profile.status,
        dailyLimit,
        usedDailyLimit,
        remainingDailyLimit,
        rejectionReason: profile.rejectionReason,
        submittedAt: profile.submittedAt,
        verifiedAt: profile.verifiedAt,
      };

      res.status(200).json({
        success: true,
        data: response,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/kyc/submit
   * Submit identity verification details for Tier 1 or Tier 2.
   */
  public static async submitKyc(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const {
        firstName,
        lastName,
        dateOfBirth,
        nationality,
        idDocumentType,
        idDocumentNumber,
        idDocumentFrontUrl,
        idDocumentBackUrl,
        proofOfAddressUrl,
        targetTier,
      } = req.body || {};

      const profile = await kycService.submitKyc({
        userId: req.user.id,
        targetTier: targetTier || 'TIER_1',
        firstName,
        lastName,
        dateOfBirth,
        nationality,
        idDocumentType,
        idDocumentNumber,
        idDocumentFrontUrl,
        idDocumentBackUrl,
        proofOfAddressUrl,
      });

      res.status(201).json({
        success: true,
        data: { profile },
        message: 'KYC submission received and is currently under review.',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/kyc/review
   * Compliance/Admin endpoint to approve or reject a user KYC submission.
   */
  public static async reviewKyc(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const { userId, approved, assignedTier, rejectionReason } = req.body || {};

      if (!userId || typeof approved !== 'boolean') {
        throw new AppError('userId and approved (boolean) are required', 400, 'INVALID_INPUT');
      }

      const profile = await kycService.reviewKyc({
        reviewerId: req.user.id,
        userId: String(userId),
        approved,
        assignedTier,
        rejectionReason,
      });

      res.status(200).json({
        success: true,
        data: { profile },
        message: approved ? `User upgraded to ${profile.tier}` : 'KYC submission rejected',
      });
    } catch (err) {
      next(err);
    }
  }
}
