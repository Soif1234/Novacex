import { Router } from 'express';
import { healthRoutes } from './health.routes';
import { authRoutes } from './auth.routes';
import { ledgerRoutes } from './ledger.routes';

const router = Router();

// System health and readiness routes
router.use('/', healthRoutes);

// Authentication & Session routes
router.use('/auth', authRoutes);

// Ledger routes (balances, history, reconciliation)
router.use('/ledger', ledgerRoutes);

// Domain route placeholders (to be populated in subsequent Phase 4 steps)
// router.use('/wallet', walletRoutes);
// router.use('/spot', spotRoutes);
// router.use('/futures', futuresRoutes);
// router.use('/market', marketRoutes);

export const apiRouter = router;

