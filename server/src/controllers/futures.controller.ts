import { Request, Response, NextFunction } from 'express';
import { futuresService } from '../services/futures/futures.service';
import { futuresTpSlService } from '../services/futures/tpsl.service';
import { futuresLiquidationService } from '../services/futures/liquidation.service';
import { AppError } from '../middleware/errorHandler';
import { OrderSide, OrderType, OrderStatus } from '../models/order.model';
import { PositionSide, MarginMode } from '../models/futures.model';

/**
 * POST /api/v1/futures/orders
 * Create and execute/schedule a new Futures order.
 */
export async function createOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const {
      symbol,
      side,
      positionSide,
      type,
      price,
      quantity,
      leverage,
      marginMode,
      reduceOnly,
      closePosition,
      clientOrderId,
      timeInForce,
      accountId,
    } = req.body || {};

    if (!symbol || !side || !positionSide || !type || !quantity || !leverage || !marginMode) {
      throw new AppError('Missing required futures order fields', 400, 'MISSING_PARAMETERS');
    }

    let futuresAccountId = accountId;
    if (!futuresAccountId) {
      const futuresAcc = req.user.accounts.find(a => a.type === 'FUTURES');
      if (!futuresAcc) {
        throw new AppError('User does not possess an active FUTURES account', 400, 'FUTURES_ACCOUNT_NOT_FOUND');
      }
      futuresAccountId = futuresAcc.id;
    }

    const result = await futuresService.placeOrder({
      userId: req.user.id,
      accountId: String(futuresAccountId),
      symbol: String(symbol),
      side: side as OrderSide,
      positionSide: positionSide as PositionSide,
      type: type as OrderType,
      price: price ? String(price) : undefined,
      quantity: String(quantity),
      leverage: Number(leverage),
      marginMode: marginMode as MarginMode,
      reduceOnly: Boolean(reduceOnly),
      closePosition: Boolean(closePosition),
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
 * POST /api/v1/futures/orders/:orderId/cancel
 * Cancel an open Futures order.
 */
export async function cancelOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const orderId = req.params.orderId;
      // @ts-ignore
      // @ts-ignore
    const cancelled = await futuresService.cancelOrder(req.user.id, orderId);

    res.json({
      success: true,
      data: cancelled,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/futures/orders/open
 */
export async function getOpenOrders(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const symbol = req.query.symbol as string | undefined;
    const orders = await futuresService.getOpenOrders(req.user.id, symbol);

    res.json({
      success: true,
      data: { orders },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/futures/orders/:orderId
 */
export async function getOrder(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

      // @ts-ignore
    const orderId = req.params.orderId;
      // @ts-ignore
    const order = await futuresService.getOrder(req.user.id, orderId);

    res.json({
      success: true,
      data: order,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/futures/orders
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

    const orders = await futuresService.getOrderHistory(req.user.id, {
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
 * GET /api/v1/futures/positions
 */
export async function getPositions(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const positions = await futuresService.getPositions(req.user.id);

    res.json({
      success: true,
      data: { positions },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/futures/positions/:positionId
 */
export async function getPosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }
      // @ts-ignore

    const positionId = req.params.positionId;
      // @ts-ignore
    const position = await futuresService.getPosition(req.user.id, positionId);

    res.json({
      success: true,
      data: position,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/futures/trades
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

    const trades = await futuresService.getTradeHistory(req.user.id, {
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
 * POST /api/v1/futures/positions/:positionId/tpsl
 */
export async function setTpSl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const positionId = req.params.positionId;
    const { takeProfitEnabled, takeProfitPrice, stopLossEnabled, stopLossPrice } = req.body || {};
      // @ts-ignore

    const config = await futuresTpSlService.setConfig({
      userId: req.user.id,
      // @ts-ignore
      positionId,
      takeProfitEnabled,
      takeProfitPrice,
      stopLossEnabled,
      stopLossPrice,
    });

    res.json({
      success: true,
      data: config,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/v1/futures/positions/:positionId/tpsl
 */
export async function getTpSl(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      // @ts-ignore
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    const positionId = req.params.positionId;
      // @ts-ignore
    const config = await futuresTpSlService.getConfigForPosition(positionId);

    res.json({
      success: true,
      data: config,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/v1/futures/positions/:positionId/liquidate
 * Trigger server-side liquidation check and settlement.
 */
export async function liquidatePosition(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      // @ts-ignore
    }

    const positionId = req.params.positionId;
    const { markPrice } = req.body || {};

      // @ts-ignore
    const liquidation = await futuresLiquidationService.evaluateAndLiquidate(positionId, markPrice);

    res.json({
      success: true,
      data: liquidation,
    });
  } catch (err) {
    next(err);
  }
}
