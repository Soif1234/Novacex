import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth';
import { getBalances, getHistory, reconcile } from '../controllers/ledger.controller';

const router = Router();

/**
 * All ledger routes require authentication.
 * 
 * Read-only endpoints for users:
 *   GET /api/v1/ledger/balances   — user's balances (ownership enforced in controller)
 *   GET /api/v1/ledger/history    — user's ledger history (ownership enforced in controller)
 * 
 * Admin-only endpoints:
 *   GET /api/v1/ledger/reconcile  — balance reconciliation (ADMIN role required)
 * 
 * NOTE: There are deliberately NO public credit/debit/transfer endpoints.
 * Financial mutations are internal domain-service operations only.
 */

router.get('/balances', requireAuth, getBalances);
router.get('/history', requireAuth, getHistory);
router.get('/reconcile', requireAuth, requireRole('ADMIN'), reconcile);

export const ledgerRoutes = router;
