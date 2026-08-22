import { Request, Response, NextFunction } from 'express';
import { idempotencyService, IdempotencyService } from '../services/system/idempotency.service';
import { logger } from '../config/logger';

export interface IdempotencyOptions {
  required?: boolean;
  ttlSeconds?: number;
  service?: IdempotencyService;
}

/**
 * HTTP Idempotency Middleware.
 * Intercepts requests carrying the `Idempotency-Key` header and enforces deduplication,
 * in-flight locking, response caching, and payload conflict detection.
 */
export function idempotencyMiddleware(options: IdempotencyOptions = {}) {
  const service = options.service || idempotencyService;
  const isRequired = options.required ?? false;
  const ttlSeconds = options.ttlSeconds ?? 86400; // default 24h

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rawKey = req.header('Idempotency-Key') || req.headers['idempotency-key'];
    const key = typeof rawKey === 'string' ? rawKey.trim() : Array.isArray(rawKey) ? rawKey[0].trim() : undefined;

    // 1. If key is missing
    if (!key || key.length === 0) {
      if (isRequired) {
        res.status(400).json({
          success: false,
          error: {
            code: 'MISSING_IDEMPOTENCY_KEY',
            message: 'Idempotency-Key header is required for this endpoint',
            requestId: req.id,
          },
        });
        return;
      }
      return next();
    }

    // 2. Validate key length and format
    if (key.length > 255) {
      res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_IDEMPOTENCY_KEY',
          message: 'Idempotency-Key header must not exceed 255 characters',
          requestId: req.id,
        },
      });
      return;
    }

    // 3. Resolve user identity context
    const userId = req.user?.id || req.apiKeyId || req.ip || 'anonymous_user';

    // 4. Compute request fingerprint
    const path = req.originalUrl || req.baseUrl + req.path;
    const fingerprint = service.computeFingerprint(req.method, path, req.body);

    try {
      // 5. Attempt acquisition
      const result = await service.acquireKey(userId, key, fingerprint, ttlSeconds);

      if (result.status === 'CONFLICT') {
        res.status(409).json({
          success: false,
          error: {
            code: 'IDEMPOTENCY_CONFLICT',
            message: result.message,
            requestId: req.id,
          },
        });
        return;
      }

      if (result.status === 'PROCESSING') {
        res.status(409).json({
          success: false,
          error: {
            code: 'IDEMPOTENCY_CONCURRENT_REQUEST',
            message: result.message,
            requestId: req.id,
          },
        });
        return;
      }

      if (result.status === 'HIT') {
        logger.info('Idempotent request cache hit', {
          key,
          userId,
          path,
          cachedStatus: result.statusCode,
        });

        res.setHeader('X-Cache-Idempotency', 'HIT');
        if (result.headers) {
          for (const [hKey, hVal] of Object.entries(result.headers)) {
            res.setHeader(hKey, hVal);
          }
        }
        res.status(result.statusCode).json(result.body);
        return;
      }

      // 6. ACQUIRED: Intercept response to store result
      res.setHeader('X-Cache-Idempotency', 'MISS');
      const originalJson = res.json.bind(res);
      let isSaved = false;

      res.json = function (body: any) {
        if (!isSaved) {
          isSaved = true;
          // Store completed response for 2xx, 3xx, 4xx (avoid caching transient 5xx server crashes)
          if (res.statusCode < 500) {
            service.completeKey(userId, key, fingerprint, res.statusCode, body, undefined, ttlSeconds).catch(err => {
              logger.warn('Failed to complete idempotency cache', { key, error: err });
            });
          } else {
            service.releaseKey(userId, key).catch(() => {});
          }
        }
        return originalJson(body);
      };

      res.on('close', () => {
        if (!isSaved && !res.writableEnded) {
          // Connection closed prematurely
          service.releaseKey(userId, key).catch(() => {});
        }
      });

      next();
    } catch (err: any) {
      logger.error('Error during idempotency middleware processing', {
        key,
        userId,
        error: err.message,
      });
      next();
    }
  };
}

/**
 * Convenience helper enforcing that Idempotency-Key MUST be supplied
 */
export function requireIdempotency(options: Omit<IdempotencyOptions, 'required'> = {}) {
  return idempotencyMiddleware({ ...options, required: true });
}
