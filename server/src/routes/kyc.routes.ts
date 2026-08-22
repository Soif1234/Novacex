import { Router } from 'express';
import { KycController } from '../controllers/kyc.controller';
import { requireAuth, requireRole, requireAuthOrApiKey } from '../middleware/auth';

const router = Router();

/**
 * KYC & Compliance Routes
 * 
 * Authenticated user endpoints:
 *   GET  /api/v1/kyc/status — Get current KYC level, limits, and review status
 *   POST /api/v1/kyc/submit — Submit identity documents for verification
 * 
 * Compliance & Admin review endpoints:
 *   POST /api/v1/kyc/review — Approve or reject user KYC submission (ADMIN only)
 */

router.get('/status', requireAuthOrApiKey('READ'), KycController.getKycStatus);
router.post('/submit', requireAuth, KycController.submitKyc);
router.post('/review', requireAuth, requireRole('ADMIN'), KycController.reviewKyc);

export const kycRoutes = router;
