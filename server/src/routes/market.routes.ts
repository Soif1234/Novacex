import { Router } from 'express';
import {
  getTickers,
  getTicker,
  getOrderBook,
  getRecentTrades,
  getMarkPrice,
} from '../controllers/market.controller';

const router = Router();

/**
 * Public Market Data REST Routes
 * 
 * Endpoints:
 *   GET /api/v1/market/tickers            — List all active tickers
 *   GET /api/v1/market/ticker/:symbol     — Retrieve ticker for specific symbol
 *   GET /api/v1/market/orderbook/:symbol  — Retrieve orderbook snapshot for symbol
 *   GET /api/v1/market/trades/:symbol     — Retrieve recent trades for symbol
 *   GET /api/v1/market/mark-price/:symbol — Retrieve mark price for symbol
 */

router.get('/tickers', getTickers);
router.get('/ticker/:symbol', getTicker);
router.get('/orderbook/:symbol', getOrderBook);
router.get('/trades/:symbol', getRecentTrades);
router.get('/mark-price/:symbol', getMarkPrice);

export const marketRoutes = router;
