import { Router } from 'express';
import { requireAuth, requireAuthOrApiKey } from '../middleware/auth';
import { requireCircuitBreaker } from '../middleware/circuitBreaker';
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
 * Authenticated endpoints (Session or API Key):
 *   POST   /api/v1/spot/orders               — Place and match a new spot order (Scope: TRADE)
 *   POST   /api/v1/spot/orders/:orderId/cancel — Cancel an open spot order (Scope: TRADE)
 *   DELETE /api/v1/spot/orders/:orderId      — Cancel an open spot order (Scope: TRADE)
 *   GET    /api/v1/spot/orders/open          — Retrieve open orders (Scope: READ)
 *   GET    /api/v1/spot/orders/:orderId      — Retrieve specific order (Scope: READ)
 *   GET    /api/v1/spot/orders               — Retrieve order history (Scope: READ)
 *   GET    /api/v1/spot/trades               — Retrieve execution trade history (Scope: READ)
 * 
 * Public simulated market endpoints:
 *   GET    /api/v1/spot/orderbook/:symbol    — Public order book depth
 */

router.post('/orders', requireCircuitBreaker('SPOT_TRADING'), requireAuthOrApiKey('TRADE'), createOrder);
router.post('/orders/:orderId/cancel', requireAuthOrApiKey('TRADE'), cancelOrder);
router.delete('/orders/:orderId', requireAuthOrApiKey('TRADE'), cancelOrder);
router.get('/orders/open', requireAuthOrApiKey('READ'), getOpenOrders);
router.get('/orders/:orderId', requireAuthOrApiKey('READ'), getOrder);
router.get('/orders', requireAuthOrApiKey('READ'), getOrderHistory);
router.get('/trades', requireAuthOrApiKey('READ'), getTrades);

// Public read-only market depth
router.get('/orderbook/:symbol', getOrderBook);

export const spotRoutes = router;
