import http from 'http';
import { app } from './app';
import { env } from './config/env';
import { logger } from './config/logger';
import { db } from './config/database';
import { redis } from './config/redis';
import { migrator } from './config/migrator';
import { webSocketGateway } from './websocket';
import { workerSupervisor } from './workers/WorkerSupervisor';

let server: http.Server | null = null;
let isShuttingDown = false;

export async function startServer(): Promise<http.Server> {
  logger.info(`Starting ${env.APP_NAME} v${env.APP_VERSION} [${env.NODE_ENV}]`);

  // Initialize infrastructure connections
  try {
    await db.connect();
    await redis.connect();
  } catch (err) {
    logger.warn('Non-fatal connection warning during skeleton startup', {}, err as Error);
  }

  // Apply pending schema migrations on startup (single-instance deploy model).
  // Fail startup if migrations cannot be applied — serving with an incomplete
  // schema is worse than not starting. Disable via AUTO_MIGRATE=false.
  if (env.AUTO_MIGRATE && env.NODE_ENV !== 'test') {
    try {
      const result = await migrator.runMigrations();
      logger.info('Database migrations applied on startup', { applied: result.total });
    } catch (err) {
      logger.error('Fatal: database migration failed on startup', {}, err as Error);
      throw err;
    }
  }

  return new Promise((resolve) => {
    server = app.listen(env.PORT, env.HOST, async () => {
      logger.info(`Server successfully bound and listening on http://${env.HOST}:${env.PORT}`);
      logger.info(`Healthcheck available at http://${env.HOST}:${env.PORT}${env.API_PREFIX}/health`);
      logger.info(`Readiness available at http://${env.HOST}:${env.PORT}${env.API_PREFIX}/ready`);
      webSocketGateway.attachToServer(server!, '/ws');
      
      // Start all background workers via unified supervisor
      await workerSupervisor.startAll();
      
      resolve(server!);
    });
  });
}

export async function stopServer(): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info('Initiating graceful shutdown sequence...');

  const shutdownTimer = setTimeout(() => {
    logger.error('Graceful shutdown timeout exceeded, forcing process exit');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);

  try {
    // 0. Stop all background workers via unified supervisor
    await workerSupervisor.stopAll();

    // 1. Close WebSocket Gateway
    webSocketGateway.close();

    // 1. Stop accepting new HTTP connections
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((err) => {
          if (err) return reject(err);
          logger.info('HTTP server closed successfully');
          resolve();
        });
      });
    }

    // 2. Drain database connections
    await db.close();

    // 3. Close Redis connections
    await redis.close();


    clearTimeout(shutdownTimer);
    logger.info('Graceful shutdown completed cleanly');
  } catch (err) {
    clearTimeout(shutdownTimer);
    logger.error('Error occurred during graceful shutdown', {}, err as Error);
    throw err;
  }
}

// Handle termination signals
export function registerSignalHandlers(): void {
  const shutdownHandler = async (signal: string) => {
    logger.info(`Received termination signal: ${signal}`);
    try {
      await stopServer();
      process.exit(0);
    } catch (err) {
      logger.error('Error during signal shutdown', {}, err as Error);
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => shutdownHandler('SIGTERM'));
  process.on('SIGINT', () => shutdownHandler('SIGINT'));

  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught Exception detected', {}, err);
    shutdownHandler('UNCAUGHT_EXCEPTION');
  });

  process.on('unhandledRejection', (reason: unknown) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    logger.error('Unhandled Rejection detected', {}, error);
  });
}

// Auto-run if executed directly as entrypoint
if (process.env.NODE_ENV !== 'test' && (process.argv[1]?.endsWith('server.ts') || process.argv[1]?.endsWith('server.js'))) {
  registerSignalHandlers();
  startServer().catch((err) => {
    logger.error('Fatal error during startup bootstrap', {}, err);
    process.exit(1);
  });
}
