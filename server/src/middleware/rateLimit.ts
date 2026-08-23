import { Request, Response, NextFunction } from 'express';
import { rateLimitService, RateLimitCategory } from '../services/system/rate-limit.service';
import { AppError } from './errorHandler';
import { logger } from '../config/logger';

export interface RateLimitMiddlewareOptions {
  category?: RateLimitCategory;
  maxRequests?: number;
  windowMs?: number;
}

/**
 * Reusable Rate Limiting Middleware
 */
export function rateLimiter(options: RateLimitMiddlewareOptions = {}, service = rateLimitService) {
  const category = options.category || 'GLOBAL';

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Derive client identifier securely
      let identifier = '';
      if ((req as any).apiKey?.id) {
        identifier = `key:${(req as any).apiKey.id}`;
      } else if (req.user?.id) {
        identifier = `usr:${req.user.id}`;
      } else {
        const rawIp = req.ip || req.socket.remoteAddress || 'unknown-ip';
        identifier = `ip:${rawIp.replace(/[^a-zA-Z0-9:._-]/g, '')}`;
      }

      const result = await service.checkRateLimit(
        identifier,
        category,
        options.maxRequests,
        options.windowMs
      );

      // Set standard RFC-compatible rate limiting headers
      if (typeof res.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', result.limit.toString());
        res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
        res.setHeader('X-RateLimit-Reset', result.resetTime.toString());
      }

      if (!result.allowed) {
        if (typeof res.setHeader === 'function') {
          res.setHeader('Retry-After', result.retryAfterSeconds.toString());
        }
        logger.warn('Rate limit exceeded', {
          identifier,
          category,
          path: req.originalUrl,
          retryAfter: result.retryAfterSeconds,
        });

        return next(
          new AppError(
            'Rate limit exceeded. Please try again later.',
            429,
            'RATE_LIMIT_EXCEEDED',
            { retryAfterSeconds: result.retryAfterSeconds }
          )
        );
      }

      next();
    } catch (err) {
      // Rate limiting errors should fail open safely
      logger.error('Rate limiting middleware error', { error: (err as Error).message });
      next();
    }
  };
}

export const globalRateLimiter = () => rateLimiter({ category: 'GLOBAL' });
export const authRateLimiter = (maxRequests?: number, windowMs?: number) =>
  rateLimiter({ category: 'AUTH', maxRequests, windowMs });
export const mutationRateLimiter = (maxRequests?: number, windowMs?: number) =>
  rateLimiter({ category: 'MUTATION', maxRequests, windowMs });
