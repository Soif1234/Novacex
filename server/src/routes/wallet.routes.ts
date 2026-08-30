import { Router } from 'express';
import { requireAuth, requireRole, requireAuthOrApiKey, require2FA } from '../middleware/auth';
import { requireCircuitBreaker } from '../middleware/circuitBreaker';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { mutationRateLimiter } from '../middleware/rateLimit';
import {
  getBalances,
  adminPaperDeposit,
  paperWithdraw,
  cryptoWithdraw,
  internalTransfer,
  getTransactions,
  getDepositAddress
} from '../controllers/wallet.controller';

const router = Router();

/**
 * Wallet Routes
 * 
 * Authenticated user / API key endpoints:
 *   GET  /api/v1/wallet/balances       — View own wallet balances (Scope: READ)
 *   POST /api/v1/wallet/withdraw       — Paper withdrawal from own account (Scope: WITHDRAW + 2FA)
 *   POST /api/v1/wallet/withdraw/crypto — Real crypto withdrawal
 *   POST /api/v1/wallet/transfer       — Internal transfer between own accounts (Scope: TRADE)
 *   GET  /api/v1/wallet/transactions   — View own transaction history (Scope: READ)
  * 
 * Admin-only endpoints:
 *   POST /api/v1/wallet/admin/paper-deposit — Admin controlled paper/demo deposit
 */

router.get('/balances', requireAuthOrApiKey('READ'), getBalances);
router.get('/deposit-address', requireAuthOrApiKey('READ'), getDepositAddress);
router.post('/withdraw', requireCircuitBreaker('WITHDRAWALS'), requireAuthOrApiKey('WITHDRAW'), require2FA, mutationRateLimiter(), idempotencyMiddleware(), paperWithdraw);
router.post('/withdraw/crypto', requireCircuitBreaker('WITHDRAWALS'), requireAuthOrApiKey('WITHDRAW'), require2FA, mutationRateLimiter(), idempotencyMiddleware(), cryptoWithdraw);
router.post('/transfer', requireAuthOrApiKey('TRADE'), mutationRateLimiter(), idempotencyMiddleware(), internalTransfer);
router.get('/transactions', requireAuthOrApiKey('READ'), getTransactions);

// Admin-only paper deposit
router.post('/admin/paper-deposit', requireCircuitBreaker('DEPOSITS'), requireAuth, requireRole('ADMIN'), idempotencyMiddleware(), adminPaperDeposit);

export const walletRoutes = router;
