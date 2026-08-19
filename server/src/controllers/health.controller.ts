import { Request, Response } from 'express';
import { env } from '../config/env';
import { db } from '../config/database';
import { redis } from '../config/redis';

const startTime = Date.now();

export class HealthController {
  public static getHealth(req: Request, res: Response): void {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    res.status(200).json({
      success: true,
      data: {
        status: 'pass',
        service: env.APP_NAME,
        version: env.APP_VERSION,
        environment: env.NODE_ENV,
        uptime: uptimeSeconds,
        timestamp: new Date().toISOString()
      }
    });
  }

  public static async getReadiness(req: Request, res: Response): Promise<void> {
    const [dbHealth, redisHealth] = await Promise.all([
      db.healthCheck(),
      redis.healthCheck()
    ]);

    const isReady = dbHealth.healthy && redisHealth.healthy;
    const statusCode = isReady ? 200 : 503;

    res.status(statusCode).json({
      success: isReady,
      data: {
        status: isReady ? 'ready' : 'unready',
        checks: {
          database: {
            status: dbHealth.healthy ? 'pass' : 'fail',
            latencyMs: dbHealth.latencyMs,
            ...(dbHealth.error ? { error: dbHealth.error } : {})
          },
          redis: {
            status: redisHealth.healthy ? 'pass' : 'fail',
            latencyMs: redisHealth.latencyMs,
            ...(redisHealth.error ? { error: redisHealth.error } : {})
          }
        },
        timestamp: new Date().toISOString()
      }
    });
  }
}
