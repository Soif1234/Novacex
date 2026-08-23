import { env, EnvironmentConfig } from './env';
import { logger } from './logger';

export type RedisConnectionMode = 'REDIS_CONNECTED' | 'FALLBACK_MEMORY' | 'DISCONNECTED';

export interface RedisStatus {
  connected: boolean;
  host: string;
  port: number;
  mode: RedisConnectionMode;
  reconnectAttempts: number;
  lastPingMs?: number;
  error?: string;
  config?: {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
    connectTimeoutMs: number;
  };
}

export interface IRedisConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(key: string): Promise<number>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string; fallbackMode?: boolean }>;
  getStatus(): RedisStatus;
  triggerDisconnect?(error?: Error): void;
  triggerReconnect?(): Promise<void>;
}

export class RedisClient implements IRedisConnection {
  private isConnected = false;
  private connectionError: string | null = null;
  private mode: RedisConnectionMode = 'DISCONNECTED';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isShuttingDown = false;
  private simulatedFailure = false;
  private memoryStore = new Map<string, { value: string; expiresAt?: number }>();

  constructor(private config: EnvironmentConfig = env) {}

  public setSimulatedFailure(failed: boolean): void {
    this.simulatedFailure = failed;
    if (failed && this.isConnected) {
      this.triggerDisconnect(new Error('Simulated Redis outage'));
    }
  }

  public async connect(): Promise<void> {
    this.isShuttingDown = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    logger.info('Initializing Redis connection', {
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
      connectTimeoutMs: this.config.REDIS_CONNECT_TIMEOUT_MS,
      maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
    });

    try {
      if (this.simulatedFailure) {
        throw new Error('Simulated connection failure');
      }
      this.isConnected = true;
      this.mode = 'REDIS_CONNECTED';
      this.connectionError = null;
      this.reconnectAttempts = 0;
      logger.info('Redis client connected successfully');
    } catch (err) {
      const error = err as Error;
      this.isConnected = false;
      this.connectionError = error.message;
      this.mode = 'FALLBACK_MEMORY';
      logger.error('Failed to connect to Redis, switching to in-memory fallback', {}, error);
      this.scheduleReconnect(error);
    }
  }

  public triggerDisconnect(error?: Error): void {
    if (this.isShuttingDown) return;
    this.isConnected = false;
    this.mode = 'FALLBACK_MEMORY';
    this.connectionError = error?.message || 'Connection lost';
    this.scheduleReconnect(error);
  }

  public async triggerReconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.reconnect();
  }

  private scheduleReconnect(error?: Error): void {
    if (this.isShuttingDown) return;

    if (this.reconnectAttempts < this.config.REDIS_RECONNECT_MAX_RETRIES) {
      this.reconnectAttempts++;
      const jitter = Math.floor(Math.random() * 50);
      const delay = Math.min(
        this.config.REDIS_RECONNECT_MAX_DELAY_MS,
        this.config.REDIS_RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1) + jitter
      );

      logger.warn('Redis connection lost; operating in fallback mode and scheduling reconnect', {
        attempt: this.reconnectAttempts,
        maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
        delayMs: Math.round(delay),
        error: error?.message || this.connectionError,
      });

      this.reconnectTimer = setTimeout(() => {
        this.reconnect().catch((err) => {
          logger.error('Redis reconnect attempt error', { error: (err as Error).message });
        });
      }, delay);
    } else {
      logger.error('Redis max reconnection attempts reached, maintaining in-memory fallback', {
        maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
      });
    }
  }

  private async reconnect(): Promise<void> {
    if (this.isShuttingDown) return;

    logger.info('Attempting Redis reconnection...', {
      attempt: this.reconnectAttempts,
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
    });

    try {
      if (this.simulatedFailure) {
        throw new Error('Persistent Redis network error');
      }
      this.isConnected = true;
      this.mode = 'REDIS_CONNECTED';
      this.connectionError = null;
      const totalAttempts = this.reconnectAttempts;
      this.reconnectAttempts = 0;
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      logger.info('Redis connection re-established successfully', {
        resolvedAfterAttempts: totalAttempts,
      });
    } catch (err) {
      this.isConnected = false;
      this.mode = 'FALLBACK_MEMORY';
      this.connectionError = (err as Error).message;
      this.scheduleReconnect(err as Error);
    }
  }

  public async close(): Promise<void> {
    this.isShuttingDown = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    logger.info('Closing Redis connection');
    this.isConnected = false;
    this.mode = 'DISCONNECTED';
    this.memoryStore.clear();
    logger.info('Redis connection closed');
  }

  public async get(key: string): Promise<string | null> {
    if (this.mode === 'DISCONNECTED' && !this.isConnected) {
      throw new Error('Redis is not connected');
    }
    const item = this.memoryStore.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryStore.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.mode === 'DISCONNECTED' && !this.isConnected) {
      throw new Error('Redis is not connected');
    }
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.memoryStore.set(key, { value, expiresAt });
  }

  public async del(key: string): Promise<number> {
    if (this.mode === 'DISCONNECTED' && !this.isConnected) {
      throw new Error('Redis is not connected');
    }
    return this.memoryStore.delete(key) ? 1 : 0;
  }

  public async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.mode === 'DISCONNECTED' && !this.isConnected) {
      throw new Error('Redis is not connected');
    }
    let item = this.memoryStore.get(key);
    let count = 1;
    if (item) {
      if (item.expiresAt && Date.now() > item.expiresAt) {
        count = 1;
      } else {
        count = (parseInt(item.value, 10) || 0) + 1;
      }
    }
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : item?.expiresAt;
    this.memoryStore.set(key, { value: count.toString(), expiresAt });
    return count;
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string; fallbackMode?: boolean }> {
    const start = Date.now();
    try {
      if (this.mode === 'DISCONNECTED') {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: this.connectionError || 'Redis client disconnected',
          fallbackMode: false,
        };
      }

      if (this.mode === 'FALLBACK_MEMORY') {
        return {
          healthy: true,
          latencyMs: Date.now() - start,
          error: this.connectionError ? `Degraded (in-memory fallback): ${this.connectionError}` : undefined,
          fallbackMode: true,
        };
      }

      const latencyMs = Date.now() - start;
      return {
        healthy: true,
        latencyMs,
        fallbackMode: false,
      };
    } catch (err) {
      const error = err as Error;
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error.message,
        fallbackMode: false,
      };
    }
  }

  public getStatus(): RedisStatus {
    return {
      connected: this.isConnected,
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
      mode: this.mode,
      reconnectAttempts: this.reconnectAttempts,
      error: this.connectionError || undefined,
      config: {
        maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
        baseDelayMs: this.config.REDIS_RECONNECT_BASE_DELAY_MS,
        maxDelayMs: this.config.REDIS_RECONNECT_MAX_DELAY_MS,
        connectTimeoutMs: this.config.REDIS_CONNECT_TIMEOUT_MS,
      },
    };
  }
}

export const redis = new RedisClient();
