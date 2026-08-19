import { Request, Response, NextFunction } from 'express';
import { spotService } from '../services/spot/spot.service';
import { AppError } from '../middleware/errorHandler';
import { OrderSide, OrderType, OrderStatus } from '../models/order.model';

/**
 * POST /api/v1/spot/orders
 * Create and match a new Spot order.
 */
export async function createOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const { symbol, side, type, price, quantity, clientOrderId, timeInForce, accountId } = req.body || {};

    if (!symbol || !side || !type || !quantity) {
      throw new AppError('symbol, side, type, and quantity are required', 400, 'MISSING_PARAMETERS');
    }

    // Resolve user's SPOT account
    let spotAccountId = accountId;
    if (!spotAccountId) {
      const spotAcc = req.user.accounts.find(a => a.type === 'SPOT');
      if (!spotAcc) {
        throw new AppError('User does not possess an active SPOT account', 400, 'SPOT_ACCOUNT_NOT_FOUND');
      }
      spotAccountId = spotAcc.id;
    }

    const result = await spotService.placeOrder({
      userId: req.user.id,
      accountId: String(spotAccountId),
      symbol: String(symbol),
      side: side as OrderSide,
      type: type as OrderType,
      price: price ? String(price) : undefined,
      quantity: String(quantity),
      clientOrderId: clientOrderId ? String(clientOrderId) : undefined,
      timeInForce: timeInForce ? String(timeInForce) : undefined,
    });

    res.status(201).json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/spot/orders/:orderId/cancel
 * Cancel an open Spot order and release remaining locked funds.
 */
export async function cancelOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const orderId = req.params.orderId;
    if (!orderId) {
      throw new AppError('orderId parameter is required', 400, 'MISSING_ORDER_ID');
    }

    const cancelled = await spotService.cancelOrder(req.user.id, orderId);

    res.json({
      success: true,
      data: cancelled,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/spot/orders/open
 * Retrieve all open orders for authenticated user.
 */
export async function getOpenOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const symbol = req.query.symbol as string | undefined;
    const orders = await spotService.getOpenOrders(req.user.id, symbol);

    res.json({
      success: true,
      data: { orders },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/spot/orders/:orderId
 * Retrieve single order by ID with ownership verification.
 */
export async function getOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const orderId = req.params.orderId;
    const order = await spotService.getOrder(req.user.id, orderId);

    res.json({
      success: true,
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/spot/orders
 * Retrieve paginated order history for authenticated user.
 */
export async function getOrderHistory(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const symbol = req.query.symbol as string | undefined;
    const status = req.query.status as OrderStatus | undefined;
    const side = req.query.side as OrderSide | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;

    const orders = await spotService.getOrderHistory(req.user.id, {
      symbol,
      status,
      side,
      page,
      pageSize,
    });

    res.json({
      success: true,
      data: { orders },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/spot/trades
 * Retrieve paginated trade execution history for authenticated user.
 */
export async function getTrades(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const symbol = req.query.symbol as string | undefined;
    const orderId = req.query.orderId as string | undefined;
    const page = req.query.page ? parseInt(req.query.page as string, 10) : undefined;
    const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : undefined;

    const trades = await spotService.getTradeHistory(req.user.id, {
      symbol,
      orderId,
      page,
      pageSize,
    });

    res.json({
      success: true,
      data: { trades },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/spot/orderbook/:symbol
 * Public/read-only endpoint for simulated Spot order book depth.
 */
export async function getOrderBook(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const symbol = req.params.symbol;
    if (!symbol) {
      throw new AppError('Symbol is required', 400, 'MISSING_SYMBOL');
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const depth = spotService.getOrderBookDepth(symbol, limit);

    res.json({
      success: true,
      data: depth,
    });
  } catch (err) {
    next(err);
  }
}
