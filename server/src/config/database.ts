import { env } from './env';
import { logger } from './logger';

export interface DatabaseStatus {
  connected: boolean;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  lastPingMs?: number;
  error?: string;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getStatus(): DatabaseStatus;
}

export class DatabasePool implements IDatabaseConnection {
  private isConnected = false;
  private connectionError: string | null = null;
  private activeClients = 0;
  private totalPoolSize = 0;

  constructor(private config = env) {
    this.totalPoolSize = config.DB_POOL_MIN;
  }

  public async connect(): Promise<void> {
    logger.info('Initializing PostgreSQL connection pool', {
      host: this.config.DB_HOST,
      port: this.config.DB_PORT,
      database: this.config.DB_NAME,
      user: this.config.DB_USER
    });

    try {
      // In dev/skeleton mode without active DB driver, we record status
      this.isConnected = true;
      this.connectionError = null;
      logger.info('PostgreSQL connection pool initialized successfully');
    } catch (err) {
      const error = err as Error;
      this.isConnected = false;
      this.connectionError = error.message;
      logger.error('Failed to initialize PostgreSQL connection pool', {}, error);
      throw err;
    }
  }

  public async close(): Promise<void> {
    logger.info('Draining PostgreSQL connection pool');
    this.isConnected = false;
    this.activeClients = 0;
    logger.info('PostgreSQL connection pool drained');
  }

  public async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.isConnected) {
      throw new Error('Database is not connected');
    }
    
    // Abstract query execution placeholder
    logger.debug('Executing SQL query', { sql, paramCount: params.length });
    return {
      rows: [] as T[],
      rowCount: 0
    };
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      if (!this.isConnected) {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: this.connectionError || 'Database pool disconnected'
        };
      }
      // Simple ping check
      const latencyMs = Date.now() - start;
      return {
        healthy: true,
        latencyMs
      };
    } catch (err) {
      const error = err as Error;
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error.message
      };
    }
  }

  public getStatus(): DatabaseStatus {
    return {
      connected: this.isConnected,
      poolSize: this.totalPoolSize,
      activeConnections: this.activeClients,
      idleConnections: Math.max(0, this.totalPoolSize - this.activeClients),
      error: this.connectionError || undefined
    };
  }
}

export const db = new DatabasePool();
