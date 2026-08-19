import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import {
  getBalances,
  adminPaperDeposit,
  paperWithdraw,
  internalTransfer,
  getTransactions,
} from '../controllers/wallet.controller';

const router = Router();

/**
 * Wallet Routes
 * 
 * Authenticated user endpoints:
 *   GET  /api/v1/wallet/balances       — View own wallet balances
 *   POST /api/v1/wallet/withdraw       — Paper withdrawal from own account
 *   POST /api/v1/wallet/transfer       — Internal transfer between own accounts (SPOT/FUTURES/FUNDING)
 *   GET  /api/v1/wallet/transactions   — View own transaction history
 * 
 * Admin-only endpoints:
 *   POST /api/v1/wallet/admin/paper-deposit — Admin controlled paper/demo deposit
 */

router.get('/balances', requireAuth, getBalances);
router.post('/withdraw', requireAuth, paperWithdraw);
router.post('/transfer', requireAuth, internalTransfer);
router.get('/transactions', requireAuth, getTransactions);

// Admin-only paper deposit
router.post('/admin/paper-deposit', requireAuth, requireRole('ADMIN'), adminPaperDeposit);

export const walletRoutes = router;
