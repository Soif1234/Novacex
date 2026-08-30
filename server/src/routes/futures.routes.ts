import { Router } from 'express';
import { requireAuth, requireAuthOrApiKey } from '../middleware/auth';
import { requireCircuitBreaker } from '../middleware/circuitBreaker';
import { idempotencyMiddleware } from '../middleware/idempotency';
import { mutationRateLimiter } from '../middleware/rateLimit';
import {
  createOrder,
  cancelOrder,
  getOpenOrders,
  getOrder,
  getOrderHistory,
  getPositions,
  getPosition,
  getTrades,
  setTpSl,
  getTpSl,
  liquidatePosition,
} from '../controllers/futures.controller';

const router = Router();

/**
 * Futures Trading Routes
 * 
 * Authenticated endpoints (Session or API Key):
 *   POST   /api/v1/futures/orders                    — Place & execute/schedule futures order (Scope: TRADE)
 *   POST   /api/v1/futures/orders/:orderId/cancel    — Cancel an open futures order (Scope: TRADE)
 *   DELETE /api/v1/futures/orders/:orderId           — Cancel an open futures order (REST alias) (Scope: TRADE)
 *   GET    /api/v1/futures/orders/open               — Retrieve open orders (Scope: READ)
 *   GET    /api/v1/futures/orders/:orderId           — Retrieve specific order (Scope: READ)
 *   GET    /api/v1/futures/orders                    — Retrieve order history (Scope: READ)
 *   GET    /api/v1/futures/positions                 — Retrieve open positions (Scope: READ)
 *   GET    /api/v1/futures/positions/:positionId     — Retrieve single position (Scope: READ)
 *   GET    /api/v1/futures/trades                    — Retrieve futures execution trades (Scope: READ)
 *   POST   /api/v1/futures/positions/:positionId/tpsl — Set or update TP/SL config (Scope: TRADE)
 *   GET    /api/v1/futures/positions/:positionId/tpsl — Retrieve TP/SL config (Scope: READ)
 *   POST   /api/v1/futures/positions/:positionId/liquidate — Trigger liquidation evaluation (Scope: TRADE)
 */

router.post('/orders', requireCircuitBreaker('FUTURES_TRADING'), requireAuthOrApiKey('TRADE'), mutationRateLimiter(), idempotencyMiddleware(), createOrder);
router.post('/orders/:orderId/cancel', requireAuthOrApiKey('TRADE'), mutationRateLimiter(), cancelOrder);
router.delete('/orders/:orderId', requireAuthOrApiKey('TRADE'), mutationRateLimiter(), cancelOrder);
router.get('/orders/open', requireAuthOrApiKey('READ'), getOpenOrders);
router.get('/orders/:orderId', requireAuthOrApiKey('READ'), getOrder);
router.get('/orders', requireAuthOrApiKey('READ'), getOrderHistory);

router.get('/positions', requireAuthOrApiKey('READ'), getPositions);
router.get('/positions/:positionId', requireAuthOrApiKey('READ'), getPosition);
router.get('/trades', requireAuthOrApiKey('READ'), getTrades);

router.post('/positions/:positionId/tpsl', requireAuthOrApiKey('TRADE'), setTpSl);
router.get('/positions/:positionId/tpsl', requireAuthOrApiKey('READ'), getTpSl);
router.post('/positions/:positionId/liquidate', requireAuthOrApiKey('TRADE'), liquidatePosition);

export const futuresRoutes = router;
