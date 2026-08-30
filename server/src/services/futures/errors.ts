import { AppError } from '../../middleware/errorHandler';

/**
 * Futures Error Codes
 * Explicit typed error identifiers for Futures risk, margin, position, and liquidation operations.
 */
export const FuturesErrorCode = {
  INVALID_FUTURES_SYMBOL: 'INVALID_FUTURES_SYMBOL',
  CONTRACT_DISABLED: 'CONTRACT_DISABLED',
  INVALID_POSITION_SIDE: 'INVALID_POSITION_SIDE',
  INVALID_ORDER_SIDE: 'INVALID_ORDER_SIDE',
  INVALID_ORDER_TYPE: 'INVALID_ORDER_TYPE',
  INVALID_QUANTITY: 'INVALID_QUANTITY',
  INVALID_PRICE: 'INVALID_PRICE',
  INVALID_LEVERAGE: 'INVALID_LEVERAGE',
  INVALID_MARGIN_MODE: 'INVALID_MARGIN_MODE',
  INSUFFICIENT_COLLATERAL: 'INSUFFICIENT_COLLATERAL',
  POSITION_NOT_FOUND: 'POSITION_NOT_FOUND',
  NO_POSITION_TO_CLOSE: 'NO_POSITION_TO_CLOSE',
  POSITION_ALREADY_CLOSED: 'POSITION_ALREADY_CLOSED',
  POSITION_ALREADY_LIQUIDATED: 'POSITION_ALREADY_LIQUIDATED',
  LIQUIDATION_NOT_ELIGIBLE: 'LIQUIDATION_NOT_ELIGIBLE',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  ORDER_NOT_CANCELLABLE: 'ORDER_NOT_CANCELLABLE',
  ACCOUNT_OWNERSHIP_DENIED: 'ACCOUNT_OWNERSHIP_DENIED',
  DUPLICATE_CLIENT_ORDER_ID: 'DUPLICATE_CLIENT_ORDER_ID',
  REFERENCE_CONFLICT: 'REFERENCE_CONFLICT',
  REDUCE_ONLY_VIOLATION: 'REDUCE_ONLY_VIOLATION',
  LEVERAGE_MISMATCH: 'LEVERAGE_MISMATCH',
  MARGIN_MODE_MISMATCH: 'MARGIN_MODE_MISMATCH',
  MINIMUM_QUANTITY_NOT_MET: 'MINIMUM_QUANTITY_NOT_MET',
} as const;

export type FuturesErrorCodeType = typeof FuturesErrorCode[keyof typeof FuturesErrorCode];

export class FuturesError extends AppError {
  constructor(message: string, statusCode: number, code: FuturesErrorCodeType, details?: unknown) {
    super(message, statusCode, code, details);
    this.name = 'FuturesError';
  }
}

export class InvalidFuturesSymbolError extends FuturesError {
  constructor(symbol: string, reason = 'Futures contract is not registered') {
    super(`Invalid futures contract "${symbol}": ${reason}`, 400, FuturesErrorCode.INVALID_FUTURES_SYMBOL, { symbol, reason });
  }
}

export class InvalidLeverageError extends FuturesError {
  constructor(leverage: number, maxLeverage = 125) {
    super(`Invalid leverage ${leverage}x: must be between 1x and ${maxLeverage}x`, 400, FuturesErrorCode.INVALID_LEVERAGE, { leverage, maxLeverage });
  }
}

export class InsufficientCollateralError extends FuturesError {
  constructor(required: string, available: string, asset = 'FUTURES_USDT') {
    super(`Insufficient margin collateral. Required: ${required} ${asset}, Available: ${available} ${asset}`, 400, FuturesErrorCode.INSUFFICIENT_COLLATERAL, { required, available, asset });
  }
}

export class PositionNotFoundError extends FuturesError {
  constructor(positionIdOrSymbol: string) {
    super(`Futures position "${positionIdOrSymbol}" was not found`, 404, FuturesErrorCode.POSITION_NOT_FOUND, { positionIdOrSymbol });
  }
}

export class NoPositionToCloseError extends FuturesError {
  constructor(symbol: string, positionSide: string) {
    super(`Cannot execute close order: no open ${positionSide} position found for ${symbol}`, 400, FuturesErrorCode.NO_POSITION_TO_CLOSE, { symbol, positionSide });
  }
}

export class LiquidationNotEligibleError extends FuturesError {
  constructor(positionId: string, equity: string, maintenanceMargin: string) {
    super(`Position "${positionId}" is not eligible for liquidation (Equity ${equity} >= MM ${maintenanceMargin})`, 400, FuturesErrorCode.LIQUIDATION_NOT_ELIGIBLE, { positionId, equity, maintenanceMargin });
  }
}

export class PositionAlreadyLiquidatedError extends FuturesError {
  constructor(positionId: string) {
    super(`Position "${positionId}" has already been liquidated or closed`, 400, FuturesErrorCode.POSITION_ALREADY_LIQUIDATED, { positionId });
  }
}
