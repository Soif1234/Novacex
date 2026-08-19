import { AppError } from '../../middleware/errorHandler';

/**
 * Spot Error Codes
 * Explicit typed error identifiers for Spot order and matching operations.
 */
export const SpotErrorCode = {
  INVALID_TRADING_PAIR: 'INVALID_TRADING_PAIR',
  PAIR_DISABLED: 'PAIR_DISABLED',
  INVALID_ORDER_SIDE: 'INVALID_ORDER_SIDE',
  INVALID_ORDER_TYPE: 'INVALID_ORDER_TYPE',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  INVALID_PRICE: 'INVALID_PRICE',
  INSUFFICIENT_AVAILABLE_BALANCE: 'INSUFFICIENT_AVAILABLE_BALANCE',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  ACCOUNT_OWNERSHIP_DENIED: 'ACCOUNT_OWNERSHIP_DENIED',
  DUPLICATE_CLIENT_ORDER_ID: 'DUPLICATE_CLIENT_ORDER_ID',
  REFERENCE_CONFLICT: 'REFERENCE_CONFLICT',
  NO_LIQUIDITY: 'NO_LIQUIDITY',
  SELF_TRADE_PREVENTED: 'SELF_TRADE_PREVENTED',
  BELOW_MIN_NOTIONAL: 'BELOW_MIN_NOTIONAL',
} as const;

export type SpotErrorCodeType = typeof SpotErrorCode[keyof typeof SpotErrorCode];

export class SpotError extends AppError {
  constructor(message: string, statusCode: number, code: SpotErrorCodeType, details?: unknown) {
    super(message, statusCode, code, details);
    this.name = 'SpotError';
  }
}

export class InvalidTradingPairError extends SpotError {
  constructor(symbol: string, reason = 'Trading pair is not registered in the system') {
    super(`Invalid trading pair "${symbol}": ${reason}`, 400, SpotErrorCode.INVALID_TRADING_PAIR, { symbol, reason });
  }
}

export class PairDisabledError extends SpotError {
  constructor(symbol: string) {
    super(`Trading pair "${symbol}" is currently disabled for trading`, 400, SpotErrorCode.PAIR_DISABLED, { symbol });
  }
}

export class InvalidOrderSideError extends SpotError {
  constructor(side: string) {
    super(`Invalid order side "${side}": must be BUY or SELL`, 400, SpotErrorCode.INVALID_ORDER_SIDE, { side });
  }
}

export class InvalidOrderTypeError extends SpotError {
  constructor(type: string) {
    super(`Invalid order type "${type}": must be LIMIT or MARKET`, 400, SpotErrorCode.INVALID_ORDER_TYPE, { type });
  }
}

export class OrderNotFoundError extends SpotError {
  constructor(orderId: string) {
    super(`Order "${orderId}" was not found`, 404, SpotErrorCode.ORDER_NOT_FOUND, { orderId });
  }
}

export class OrderNotCancellableError extends SpotError {
  constructor(orderId: string, status: string) {
    super(`Order "${orderId}" cannot be cancelled in status "${status}"`, 400, SpotErrorCode.ORDER_NOT_CANCELLABLE, { orderId, status });
  }
}

export class NoLiquidityError extends SpotError {
  constructor(symbol: string, side: string) {
    super(`Cannot execute market ${side} on ${symbol}: order book has no available liquidity`, 400, SpotErrorCode.NO_LIQUIDITY, { symbol, side });
  }
}

export class BelowMinNotionalError extends SpotError {
  constructor(notional: string, minNotional: string) {
    super(`Order notional (${notional}) is below minimum required notional (${minNotional})`, 400, SpotErrorCode.BELOW_MIN_NOTIONAL, { notional, minNotional });
  }
}
