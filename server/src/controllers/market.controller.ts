import { Request, Response, NextFunction } from 'express';
import { marketDataService } from '../services/market/market.service';
import { AppError } from '../middleware/errorHandler';

/**
 * GET /api/v1/market/tickers
 */
export async function getTickers(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const tickers = marketDataService.getAllTickers();
    res.json({
      success: true,
      data: { tickers },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/market/ticker/:symbol
 */
export async function getTicker(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = req.params.symbol;
    const ticker = marketDataService.getTicker(symbol);
    if (!ticker) {
      throw new AppError(`Market symbol "${symbol}" was not found`, 404, 'MARKET_NOT_FOUND');
    }

    res.json({
      success: true,
      data: ticker,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/market/orderbook/:symbol
 */
export async function getOrderBook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = req.params.symbol;
    const depth = req.query.depth ? parseInt(req.query.depth as string, 10) : 50;

    const book = marketDataService.getOrderBook(symbol, depth);
    res.json({
      success: true,
      data: book,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/market/trades/:symbol
 */
export async function getRecentTrades(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = req.params.symbol;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const trades = marketDataService.getRecentTrades(symbol, limit);
    res.json({
      success: true,
      data: { trades },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/market/mark-price/:symbol
 */
export async function getMarkPrice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = req.params.symbol;
    const markPrice = await marketDataService.getMarkPrice(symbol);

    res.json({
      success: true,
      data: markPrice,
    });
  } catch (err) {
    next(err);
  }
}
