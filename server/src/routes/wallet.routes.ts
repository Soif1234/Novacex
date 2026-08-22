import { Router } from 'express';
import { requireAuth, requireRole, requireAuthOrApiKey, require2FA } from '../middleware/auth';
import { requireCircuitBreaker } from '../middleware/circuitBreaker';
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
 * Authenticated user / API key endpoints:
 *   GET  /api/v1/wallet/balances       — View own wallet balances (Scope: READ)
 *   POST /api/v1/wallet/withdraw       — Paper withdrawal from own account (Scope: WITHDRAW + 2FA)
 *   POST /api/v1/wallet/transfer       — Internal transfer between own accounts (Scope: TRADE)
 *   GET  /api/v1/wallet/transactions   — View own transaction history (Scope: READ)
 * 
 * Admin-only endpoints:
 *   POST /api/v1/wallet/admin/paper-deposit — Admin controlled paper/demo deposit
 */

router.get('/balances', requireAuthOrApiKey('READ'), getBalances);
router.post('/withdraw', requireCircuitBreaker('WITHDRAWALS'), requireAuthOrApiKey('WITHDRAW'), require2FA, paperWithdraw);
router.post('/transfer', requireAuthOrApiKey('TRADE'), internalTransfer);
router.get('/transactions', requireAuthOrApiKey('READ'), getTransactions);

// Admin-only paper deposit
router.post('/admin/paper-deposit', requireCircuitBreaker('DEPOSITS'), requireAuth, requireRole('ADMIN'), adminPaperDeposit);

export const walletRoutes = router;

