import { Router } from 'express';
import { healthRoutes } from './health.routes';
import { authRoutes } from './auth.routes';
import { ledgerRoutes } from './ledger.routes';
import { walletRoutes } from './wallet.routes';
import { spotRoutes } from './spot.routes';
import { futuresRoutes } from './futures.routes';
import { marketRoutes } from './market.routes';
import { kycRoutes } from './kyc.routes';
import { adminRoutes } from './admin.routes';

const router = Router();

// System health and readiness routes
router.use('/', healthRoutes);

// Authentication & Session routes
router.use('/auth', authRoutes);

// Admin & Security Audit routes
router.use('/admin', adminRoutes);

// KYC & AML Compliance routes
router.use('/kyc', kycRoutes);

// Ledger routes (balances, history, reconciliation)
router.use('/ledger', ledgerRoutes);

// Wallet routes (balances, paper deposit, paper withdrawal, internal transfers, transactions)
router.use('/wallet', walletRoutes);

// Spot routes (order placement, matching, cancellation, trade history, order book)
router.use('/spot', spotRoutes);

// Futures routes (order placement, positions, TP/SL, liquidation, trade history)
router.use('/futures', futuresRoutes);

// Market data routes (tickers, orderbook snapshots, recent trades, mark prices)
router.use('/market', marketRoutes);

export const apiRouter = router;





