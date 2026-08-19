import { Request, Response, NextFunction } from 'express';
import { logger } from '../config/logger';

export class AppError extends Error {
  public statusCode: number;
  public code: string;
  public isOperational: boolean;
  public details?: unknown;

  constructor(message: string, statusCode = 500, code = 'INTERNAL_ERROR', details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
    this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

export function notFoundHandler(req: Request, res: Response, next: NextFunction): void {
  const error = new AppError(`Route not found: ${req.method} ${req.originalUrl}`, 404, 'NOT_FOUND');
  next(error);
}

export function errorHandler(
  err: Error | AppError,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  next: NextFunction
): void {
  const requestId = req.id || 'unknown';
  const statusCode = (err as AppError).statusCode || 500;
  const code = (err as AppError).code || 'INTERNAL_ERROR';
  const message = err.message || 'An unexpected error occurred';
  const details = (err as AppError).details;

  if (statusCode >= 500) {
    logger.error('Unhandled server error', {
      requestId,
      method: req.method,
      url: req.originalUrl,
      code,
      statusCode
    }, err);
  } else {
    logger.warn('Operational client error', {
      requestId,
      method: req.method,
      url: req.originalUrl,
      code,
      statusCode,
      message
    });
  }

  res.status(statusCode).json({
    success: false,
    error: {
      code,
      message,
      requestId,
      ...(details ? { details } : {})
    }
  });
}
