import { env } from './env';
import { logger } from './logger';

export interface RedisStatus {
  connected: boolean;
  host: string;
  port: number;
  lastPingMs?: number;
  error?: string;
}

export interface IRedisConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<number>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getStatus(): RedisStatus;
}

export class RedisClient implements IRedisConnection {
  private isConnected = false;
  private connectionError: string | null = null;
  private memoryStore = new Map<string, { value: string; expiresAt?: number }>();

  constructor(private config = env) {}

  public async connect(): Promise<void> {
    logger.info('Initializing Redis connection', {
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT
    });

    try {
      this.isConnected = true;
      this.connectionError = null;
      logger.info('Redis client connected successfully');
    } catch (err) {
      const error = err as Error;
      this.isConnected = false;
      this.connectionError = error.message;
      logger.error('Failed to connect to Redis', {}, error);
      throw err;
    }
  }

  public async close(): Promise<void> {
    logger.info('Closing Redis connection');
    this.isConnected = false;
    this.memoryStore.clear();
    logger.info('Redis connection closed');
  }

  public async get(key: string): Promise<string | null> {
    if (!this.isConnected) throw new Error('Redis is not connected');
    const item = this.memoryStore.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryStore.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (!this.isConnected) throw new Error('Redis is not connected');
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.memoryStore.set(key, { value, expiresAt });
  }

  public async del(key: string): Promise<number> {
    if (!this.isConnected) throw new Error('Redis is not connected');
    return this.memoryStore.delete(key) ? 1 : 0;
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      if (!this.isConnected) {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: this.connectionError || 'Redis client disconnected'
        };
      }
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

  public getStatus(): RedisStatus {
    return {
      connected: this.isConnected,
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
      error: this.connectionError || undefined
    };
  }
}

export const redis = new RedisClient();
