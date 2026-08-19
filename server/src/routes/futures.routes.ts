import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
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
 * Authenticated endpoints:
 *   POST   /api/v1/futures/orders                    — Place & execute/schedule futures order
 *   POST   /api/v1/futures/orders/:orderId/cancel    — Cancel an open futures order
 *   DELETE /api/v1/futures/orders/:orderId           — Cancel an open futures order (REST alias)
 *   GET    /api/v1/futures/orders/open               — Retrieve open orders
 *   GET    /api/v1/futures/orders/:orderId           — Retrieve specific order
 *   GET    /api/v1/futures/orders                    — Retrieve order history
 *   GET    /api/v1/futures/positions                 — Retrieve open positions
 *   GET    /api/v1/futures/positions/:positionId     — Retrieve single position
 *   GET    /api/v1/futures/trades                    — Retrieve futures execution trades
 *   POST   /api/v1/futures/positions/:positionId/tpsl — Set or update TP/SL config
 *   GET    /api/v1/futures/positions/:positionId/tpsl — Retrieve TP/SL config
 *   POST   /api/v1/futures/positions/:positionId/liquidate — Trigger liquidation evaluation
 */

router.post('/orders', requireAuth, createOrder);
router.post('/orders/:orderId/cancel', requireAuth, cancelOrder);
router.delete('/orders/:orderId', requireAuth, cancelOrder);
router.get('/orders/open', requireAuth, getOpenOrders);
router.get('/orders/:orderId', requireAuth, getOrder);
router.get('/orders', requireAuth, getOrderHistory);

router.get('/positions', requireAuth, getPositions);
router.get('/positions/:positionId', requireAuth, getPosition);
router.get('/trades', requireAuth, getTrades);

router.post('/positions/:positionId/tpsl', requireAuth, setTpSl);
router.get('/positions/:positionId/tpsl', requireAuth, getTpSl);
router.post('/positions/:positionId/liquidate', requireAuth, liquidatePosition);

export const futuresRoutes = router;
