import { Router } from 'express';
import { requireAuth } from '../middleware/auth';
import {
  createOrder,
  cancelOrder,
  getOpenOrders,
  getOrder,
  getOrderHistory,
  getTrades,
  getOrderBook,
} from '../controllers/spot.controller';

const router = Router();

/**
 * Spot Trading Routes
 * 
 * Authenticated endpoints:
 *   POST   /api/v1/spot/orders               — Place and match a new spot order
 *   POST   /api/v1/spot/orders/:orderId/cancel — Cancel an open spot order
 *   DELETE /api/v1/spot/orders/:orderId      — Cancel an open spot order (REST alias)
 *   GET    /api/v1/spot/orders/open          — Retrieve open orders
 *   GET    /api/v1/spot/orders/:orderId      — Retrieve specific order
 *   GET    /api/v1/spot/orders               — Retrieve order history
 *   GET    /api/v1/spot/trades               — Retrieve execution trade history
 * 
 * Public simulated market endpoints:
 *   GET    /api/v1/spot/orderbook/:symbol    — Public order book depth
 */

router.post('/orders', requireAuth, createOrder);
router.post('/orders/:orderId/cancel', requireAuth, cancelOrder);
router.delete('/orders/:orderId', requireAuth, cancelOrder);
router.get('/orders/open', requireAuth, getOpenOrders);
router.get('/orders/:orderId', requireAuth, getOrder);
router.get('/orders', requireAuth, getOrderHistory);
router.get('/trades', requireAuth, getTrades);

// Public read-only market depth
router.get('/orderbook/:symbol', getOrderBook);

export const spotRoutes = router;
