import { Request, Response } from 'express';
import { env } from '../config/env';
import { db } from '../config/database';
import { redis } from '../config/redis';
import { workerSupervisor } from '../workers/WorkerSupervisor';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';

const startTime = Date.now();

/**
 * Execute a check with a strict timeout boundary so health checks never hang.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class HealthController {
  /**
   * GET /api/v1/health/live (or /api/v1/live)
   * Lightweight Liveness Probe
   * Checks strictly that the process is alive without touching DB, Redis, or external dependencies.
   */
  public static getLiveness(req: Request, res: Response): void {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    res.status(200).json({
      success: true,
      data: {
        status: 'alive',
        service: env.APP_NAME,
        version: env.APP_VERSION,
        environment: env.NODE_ENV,
        uptime: uptimeSeconds,
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * GET /api/v1/health/ready (or /api/v1/ready)
   * Readiness Probe
   * Evaluates PostgreSQL, Redis, WorkerSupervisor, and Circuit Breaker states with strict timeout protection.
   */
  public static async getReadiness(req: Request, res: Response): Promise<void> {
    const CHECK_TIMEOUT_MS = 2000;

    const [dbHealth, redisHealth, cbStatus] = await Promise.all([
      withTimeout(
        db.healthCheck(),
        CHECK_TIMEOUT_MS,
        { healthy: false, latencyMs: CHECK_TIMEOUT_MS, error: 'Database health check timed out' }
      ),
      withTimeout(
        redis.healthCheck(),
        CHECK_TIMEOUT_MS,
        { healthy: false, latencyMs: CHECK_TIMEOUT_MS, error: 'Redis health check timed out' }
      ),
      withTimeout(
        circuitBreakerService.getPublicStatus().catch(() => ({
          isOperational: true,
          mode: 'SYSTEM_ACTIVE' as const,
          subsystems: { spotTrading: true, futuresTrading: true, withdrawals: true, deposits: true },
          updatedAt: new Date(),
        })),
        CHECK_TIMEOUT_MS,
        {
          isOperational: true,
          mode: 'SYSTEM_ACTIVE' as const,
          subsystems: { spotTrading: true, futuresTrading: true, withdrawals: true, deposits: true },
          updatedAt: new Date(),
        }
      ),
    ]);

    // Check worker supervisor state safely
    const workerStatuses = workerSupervisor.getStatuses();
    const workerValues = Object.values(workerStatuses);
    const workersCount = workerValues.length;
    const runningWorkers = workerValues.filter((w) => w.isRunning).length;
    const allWorkersRunning = workersCount === 0 || runningWorkers === workersCount;

    // Evaluate readiness criteria:
    // Database is mandatory for ready state.
    // Redis can operate in fallback mode without making the service completely unready (degraded).
    const isDbHealthy = dbHealth.healthy;
    const isRedisHealthy = redisHealth.healthy;
    const isRedisFallback = !!redisHealth.fallbackMode;

    let status: 'ready' | 'degraded' | 'unready' = 'ready';
    let isReady = true;

    if (!isDbHealthy || (!isRedisHealthy && !isRedisFallback)) {
      status = 'unready';
      isReady = false;
    } else if (isRedisFallback || !allWorkersRunning) {
      status = 'degraded';
      isReady = true;
    } else {
      status = 'ready';
      isReady = true;
    }

    const statusCode = isReady ? 200 : 503;

    res.status(statusCode).json({
      success: isReady,
      data: {
        status,
        checks: {
          database: {
            status: dbHealth.healthy ? 'pass' : 'fail',
            latencyMs: dbHealth.latencyMs,
            ...(dbHealth.error ? { error: dbHealth.error } : {}),
          },
          redis: {
            status: redisHealth.healthy ? (isRedisFallback ? 'warn' : 'pass') : 'fail',
            latencyMs: redisHealth.latencyMs,
            mode: isRedisFallback ? 'FALLBACK_MEMORY' : (redisHealth.healthy ? 'REDIS_CONNECTED' : 'DISCONNECTED'),
            ...(redisHealth.error ? { error: redisHealth.error } : {}),
          },
          workers: {
            status: allWorkersRunning ? 'pass' : 'warn',
            runningCount: runningWorkers,
            totalCount: workersCount,
          },
          circuitBreaker: {
            mode: cbStatus.mode,
            spotTrading: cbStatus.subsystems?.spotTrading ?? true,
            futuresTrading: cbStatus.subsystems?.futuresTrading ?? true,
          },
        },
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * GET /api/v1/health
   * Standard Health Overview Endpoint
   */
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
        timestamp: new Date().toISOString(),
      },
    });
  }

  /**
   * GET /api/v1/health/detailed
   * Detailed System Health Overview (Safe for ops/monitoring)
   */
  public static async getDetailedHealth(req: Request, res: Response): Promise<void> {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);
    const mem = process.memoryUsage();
    const dbStatus = db.getStatus();
    const redisStatus = redis.getStatus();
    const workerStatuses = workerSupervisor.getStatuses();
    const cbStatus = await circuitBreakerService.getPublicStatus().catch(() => ({ mode: 'SYSTEM_ACTIVE' }));

    res.status(200).json({
      success: true,
      data: {
        service: env.APP_NAME,
        version: env.APP_VERSION,
        environment: env.NODE_ENV,
        uptimeSeconds,
        timestamp: new Date().toISOString(),
        system: {
          nodeVersion: process.version,
          memoryHeapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
          memoryRssMB: Math.round(mem.rss / 1024 / 1024),
        },
        database: {
          connected: dbStatus.connected,
          poolSize: dbStatus.poolSize,
          activeConnections: dbStatus.activeConnections,
          idleConnections: dbStatus.idleConnections,
          waitingClients: dbStatus.waitingClients ?? 0,
        },
        redis: {
          connected: redisStatus.connected,
          mode: redisStatus.mode,
          reconnectAttempts: redisStatus.reconnectAttempts,
        },
        workers: workerStatuses,
        circuitBreaker: cbStatus,
      },
    });
  }
}
