import Redis from 'ioredis';
import { env, EnvironmentConfig } from './env';
import { logger } from './logger';

export type RedisConnectionMode = 'REDIS_CONNECTED' | 'FALLBACK_MEMORY' | 'DISCONNECTED';

export interface RedisStatus {
  connected: boolean;
  host: string;
  port: number;
  mode: RedisConnectionMode;
  reconnectAttempts: number;
  error?: string;
  config: {
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
  setNX(key: string, value: string, ttlSeconds: number): Promise<boolean>;
  del(key: string): Promise<number>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string; fallbackMode?: boolean }>;
  getStatus(): RedisStatus;
  triggerDisconnect(error?: Error): void;
  triggerReconnect(): Promise<void>;
  setSimulatedFailure(failed: boolean): void;
}

export class RedisClient implements IRedisConnection {
  private client: Redis | null = null;
  private isConnected = false;
  private connectionError: string | null = null;
  private mode: RedisConnectionMode = 'DISCONNECTED';
  private reconnectAttempts = 0;
  private isShuttingDown = false;
  private simulatedFailure = false;
  
  // Safe local fallback for non-critical coordination (e.g. basic rate limiting if allowed)
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
    
    logger.info('Initializing Redis connection', {
      url: this.config.REDIS_URL,
      connectTimeoutMs: this.config.REDIS_CONNECT_TIMEOUT_MS,
      maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
    });

    return new Promise((resolve) => {
      try {
        if (this.simulatedFailure) {
          throw new Error('Simulated connection failure');
        }

        const isTls = this.config.REDIS_URL.startsWith('rediss://');
        this.client = new Redis(this.config.REDIS_URL, {
          tls: isTls
            ? {
                rejectUnauthorized: this.config.REDIS_SSL_REJECT_UNAUTHORIZED,
                ...(this.config.REDIS_CA_CERT
                  ? { ca: this.config.REDIS_CA_CERT.replace(/\\n/g, '\n') }
                  : {}),
              }
            : undefined,
          connectTimeout: this.config.REDIS_CONNECT_TIMEOUT_MS,
          maxRetriesPerRequest: null, // Critical for robust error handling without crashing
          retryStrategy: (times) => {
            if (this.isShuttingDown) return null;
            if (times > this.config.REDIS_RECONNECT_MAX_RETRIES) {
              logger.error('Redis max reconnection attempts reached, maintaining in-memory fallback', {
                maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
              });
              return null; // Stop retrying
            }
            this.reconnectAttempts = times;
            const jitter = Math.floor(Math.random() * 50);
            const delay = Math.min(
              this.config.REDIS_RECONNECT_MAX_DELAY_MS,
              this.config.REDIS_RECONNECT_BASE_DELAY_MS * Math.pow(2, times - 1) + jitter
            );
            
            logger.warn('Redis connection lost; operating in fallback mode and scheduling reconnect', {
              attempt: times,
              maxRetries: this.config.REDIS_RECONNECT_MAX_RETRIES,
              delayMs: Math.round(delay),
            });
            return delay;
          }
        });

        this.client.on('connect', () => {
          this.isConnected = true;
          this.mode = 'REDIS_CONNECTED';
          this.connectionError = null;
          logger.info('Redis client connected successfully');
          resolve();
        });

        this.client.on('ready', () => {
          this.reconnectAttempts = 0; // Reset after successful connection and ready state
        });

        this.client.on('error', (error) => {
          this.isConnected = false;
          this.mode = 'FALLBACK_MEMORY';
          this.connectionError = error.message;
          logger.error('Redis connection error', { error: error.message });
          // If this is the initial connect attempt, resolve it to allow the app to boot in fallback mode
          resolve(); 
        });

        this.client.on('close', () => {
          if (!this.isShuttingDown) {
            this.isConnected = false;
            this.mode = 'FALLBACK_MEMORY';
            logger.warn('Redis connection closed unexpectedly');
          }
        });

      } catch (err) {
        const error = err as Error;
        this.isConnected = false;
        this.connectionError = error.message;
        this.mode = 'FALLBACK_MEMORY';
        logger.error('Failed to initialize Redis client, switching to in-memory fallback', {}, error);
        resolve();
      }
    });
  }

  public triggerDisconnect(error?: Error): void {
    if (this.isShuttingDown) return;
    this.isConnected = false;
    this.mode = 'FALLBACK_MEMORY';
    this.connectionError = error?.message || 'Connection lost';
    if (this.client) {
      this.client.disconnect();
    }
  }

  public async triggerReconnect(): Promise<void> {
    if (this.client && this.client.status !== 'ready' && this.client.status !== 'connecting') {
      try {
        await this.client.connect();
      } catch (e) {
        // Will be handled by the 'error' listener
      }
    }
  }

  public async close(): Promise<void> {
    this.isShuttingDown = true;
    logger.info('Closing Redis connection');
    if (this.client) {
      await this.client.quit();
    }
    this.isConnected = false;
    this.mode = 'DISCONNECTED';
    this.memoryStore.clear();
    logger.info('Redis connection closed');
  }

  public async get(key: string): Promise<string | null> {
    if (this.mode === 'REDIS_CONNECTED' && this.client && !this.simulatedFailure) {
      try {
        return await this.client.get(key);
      } catch (e) {
        logger.warn('Redis GET failed, falling back', { error: (e as Error).message });
      }
    }
    
    // Memory fallback logic
    const item = this.memoryStore.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.memoryStore.delete(key);
      return null;
    }
    return item.value;
  }

  public async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
    if (this.mode === 'REDIS_CONNECTED' && this.client && !this.simulatedFailure) {
      try {
        if (ttlSeconds) {
          await this.client.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.client.set(key, value);
        }
        return;
      } catch (e) {
        logger.warn('Redis SET failed, falling back', { error: (e as Error).message });
      }
    }
    
    const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
    this.memoryStore.set(key, { value, expiresAt });
  }

  /**
   * IMPORTANT: setNX does NOT fall back to memory because atomic idempotency / distributed locking
   * CANNOT be safely simulated in memory across multiple instances. 
   * If Redis is down, it MUST throw an error and fail closed to prevent financial duplication.
   */
  public async setNX(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    if (this.simulatedFailure) {
      throw new Error('Redis is offline (simulated) - Atomic setNX cannot safely proceed');
    }
    if (this.mode !== 'REDIS_CONNECTED' || !this.client) {
      throw new Error('Redis is offline - Atomic setNX cannot safely proceed');
    }
    
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  public async del(key: string): Promise<number> {
    if (this.mode === 'REDIS_CONNECTED' && this.client && !this.simulatedFailure) {
      try {
        return await this.client.del(key);
      } catch (e) {
        logger.warn('Redis DEL failed, falling back', { error: (e as Error).message });
      }
    }
    return this.memoryStore.delete(key) ? 1 : 0;
  }

  public async incr(key: string, ttlSeconds?: number): Promise<number> {
    if (this.mode === 'REDIS_CONNECTED' && this.client && !this.simulatedFailure) {
      try {
        if (ttlSeconds) {
          const pipeline = this.client.pipeline();
          pipeline.incr(key);
          pipeline.expire(key, ttlSeconds);
          const results = await pipeline.exec();
          if (results && results[0] && !results[0][0]) {
            return results[0][1] as number;
          }
        } else {
          return await this.client.incr(key);
        }
      } catch (e) {
        logger.warn('Redis INCR failed, falling back', { error: (e as Error).message });
      }
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

      if (this.mode === 'FALLBACK_MEMORY' || this.simulatedFailure) {
        return {
          healthy: true, // Degraded healthy
          latencyMs: Date.now() - start,
          error: `Degraded (in-memory fallback): ${this.connectionError || 'simulated failure'}`,
          fallbackMode: true,
        };
      }

      if (this.client) {
        await this.client.ping();
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
      connected: this.isConnected && !this.simulatedFailure,
      host: this.config.REDIS_HOST,
      port: this.config.REDIS_PORT,
      mode: this.simulatedFailure ? 'FALLBACK_MEMORY' : this.mode,
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
