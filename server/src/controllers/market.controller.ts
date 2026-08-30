import { Request, Response, NextFunction } from 'express';
import { marketDataService } from '../services/market/market.service';
import { klineService, Interval } from '../services/market/kline.service';
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
      // @ts-ignore
      // @ts-ignore
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
      // @ts-ignore

      // @ts-ignore
    const book = await marketDataService.getOrderBook(symbol, depth);
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
      // @ts-ignore
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

      // @ts-ignore
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
      // @ts-ignore
export async function getMarkPrice(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = req.params.symbol;
      // @ts-ignore
    const markPrice = await marketDataService.getMarkPrice(symbol);

    res.json({
      success: true,
      data: markPrice,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/market/klines
 */
export async function getKLines(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = (req.query.symbol as string || 'BTCUSDT').trim().toUpperCase();
    const market = ((req.query.market as string || 'SPOT').trim().toUpperCase()) as 'SPOT' | 'FUTURES';
    const interval = (req.query.interval as Interval || '1m');
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 500;
    const endTime = req.query.endTime ? parseInt(req.query.endTime as string, 10) : undefined;

    const klines = await klineService.getHistoricalKLines(market, symbol, interval, limit, endTime);
    res.json({
      success: true,
      data: klines,
    });
  } catch (err) {
    next(err);
  }
}

