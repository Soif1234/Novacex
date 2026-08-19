import { Router } from 'express';
import { healthRoutes } from './health.routes';
import { authRoutes } from './auth.routes';

const router = Router();

// System health and readiness routes
router.use('/', healthRoutes);

// Authentication & Session routes
router.use('/auth', authRoutes);

// Domain route placeholders (to be populated in subsequent Phase 4 steps)
// router.use('/wallet', walletRoutes);
// router.use('/ledger', ledgerRoutes);
// router.use('/spot', spotRoutes);
// router.use('/futures', futuresRoutes);
// router.use('/market', marketRoutes);

export const apiRouter = router;
