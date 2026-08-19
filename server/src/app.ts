import express, { Express, Request, Response, NextFunction } from 'express';
import { env } from './config/env';
import { logger } from './config/logger';
import { requestIdMiddleware } from './middleware/requestId';
import { securityHeadersMiddleware, corsMiddleware } from './middleware/security';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiRouter } from './routes';

export interface AppOptions {
  enableLogging?: boolean;
}

export function createApp(options: AppOptions = { enableLogging: true }): Express {
  const app = express();

  // 1. Basic security and headers
  app.use(securityHeadersMiddleware);
  app.use(corsMiddleware);

  // 2. Request parsing
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  // 3. Request identification
  app.use(requestIdMiddleware);

  // 4. Request logging
  if (options.enableLogging) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      const start = Date.now();
      res.on('finish', () => {
        const duration = Date.now() - start;
        logger.info('HTTP Request', {
          requestId: req.id,
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: duration,
          ip: req.ip
        });
      });
      next();
    });
  }

  // 5. Root status endpoint
  app.get('/', (req: Request, res: Response) => {
    res.json({
      service: env.APP_NAME,
      version: env.APP_VERSION,
      status: 'online',
      docs: `${env.API_PREFIX}/health`
    });
  });

  // 6. API v1 routes
  app.use(env.API_PREFIX, apiRouter);

  // 7. Error handling
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

export const app = createApp();
