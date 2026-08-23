import { Request, Response, NextFunction } from 'express';
import { telemetryService } from '../services/system/telemetry.service';

/**
 * Express middleware for automatic HTTP metrics collection.
 * Non-blocking, failure-isolated, and scrubs dynamic path segments to prevent cardinality explosions.
 */
export function telemetryMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();

  res.on('finish', () => {
    try {
      const durationMs = Date.now() - start;
      const path = req.originalUrl || req.baseUrl + req.path || '/';
      telemetryService.recordHttpRequest(req.method, path, res.statusCode, durationMs);
    } catch {
      // Telemetry failures are strictly isolated
    }
  });

  next();
}
