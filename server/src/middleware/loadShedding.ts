import { Request, Response, NextFunction } from 'express';
import { rateLimitService } from '../services/system/rate-limit.service';
import { AppError } from './errorHandler';
import { logger } from '../config/logger';

/**
 * Load Shedding Middleware
 * Evaluates in-flight concurrency and database pool pressure to shed excess load before system exhaustion.
 * Always bypasses essential health/liveness probes so orchestration can monitor instance health.
 */
export function loadSheddingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const path = req.originalUrl || req.path || '';

  // 1. Bypass health & liveness probes from load shedding
  if (
    path.includes('/health') ||
    path.includes('/live') ||
    path.includes('/ready')
  ) {
    return next();
  }

  // 2. Increment active concurrency
  rateLimitService.incrementConcurrency();
  let decremented = false;

  const cleanup = () => {
    if (!decremented) {
      decremented = true;
      rateLimitService.decrementConcurrency();
    }
  };

  res.on('finish', cleanup);
  res.on('close', cleanup);

  // 3. Check load shedding criteria
  try {
    const check = rateLimitService.checkLoadShedding();
    if (!check.allowed) {
      res.setHeader('Retry-After', '2');
      logger.warn('Load shedding active: shedding incoming request', {
        path,
        reason: check.reason,
        activeConcurrency: check.activeConcurrency,
      });

      return next(
        new AppError(
          'System is currently experiencing high load. Please retry in a few moments.',
          503,
          'LOAD_SHEDDING_ACTIVE',
          { retryAfterSeconds: 2, reason: check.reason }
        )
      );
    }

    next();
  } catch (err) {
    // If load shedding check fails, log and proceed safely
    logger.error('Load shedding evaluation error', { error: (err as Error).message });
    next();
  }
}
