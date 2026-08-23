import { env, EnvironmentConfig } from '../../config/env';
import { redis, IRedisConnection } from '../../config/redis';
import { db } from '../../config/database';
import { logger } from '../../config/logger';
import { telemetryService } from './telemetry.service';

export type RateLimitCategory = 'GLOBAL' | 'AUTH' | 'MUTATION' | 'API_KEY';

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetTime: number; // Unix timestamp (seconds)
  retryAfterSeconds: number;
}

export interface LoadSheddingResult {
  allowed: boolean;
  reason?: 'CONCURRENCY_EXCEEDED' | 'DB_POOL_EXHAUSTED';
  activeConcurrency: number;
}

export class RateLimitService {
  private inMemoryStore = new Map<string, { count: number; expiresAt: number }>();
  private activeConcurrency = 0;
  private readonly maxInMemoryEntries = 10000;

  constructor(
    private redisClient: IRedisConnection = redis,
    private config: EnvironmentConfig = env
  ) {}

  /**
   * Evaluate Rate Limit for a specific client identifier and category
   */
  public async checkRateLimit(
    identifier: string,
    category: RateLimitCategory = 'GLOBAL',
    customMaxRequests?: number,
    customWindowMs?: number
  ): Promise<RateLimitResult> {
    if (!this.config.RATE_LIMIT_ENABLED && !customMaxRequests) {
      return { allowed: true, limit: 999999, remaining: 999999, resetTime: Math.floor(Date.now() / 1000) + 60, retryAfterSeconds: 0 };
    }

    const windowMs = customWindowMs ?? this.config.RATE_LIMIT_WINDOW_MS;
    const maxRequests = customMaxRequests ?? this.getMaxRequestsForCategory(category);
    const windowBucket = Math.floor(Date.now() / windowMs);
    const resetTime = Math.ceil(((windowBucket + 1) * windowMs) / 1000);
    const ttlSeconds = Math.ceil(windowMs / 1000) + 1;
    const key = `rate-limit:${category.toLowerCase()}:${identifier}:${windowBucket}`;

    let currentCount = 1;

    try {
      currentCount = await this.redisClient.incr(key, ttlSeconds);
    } catch (err) {
      logger.warn('Redis rate limit incr failed; falling back to in-memory limiter', {
        key,
        error: (err as Error).message,
      });
      currentCount = this.incrementInMemory(key, windowMs);
    }

    const remaining = Math.max(0, maxRequests - currentCount);
    const allowed = currentCount <= maxRequests;
    const retryAfterSeconds = allowed ? 0 : Math.max(1, resetTime - Math.floor(Date.now() / 1000));

    if (!allowed) {
      telemetryService.incrementCounter('rate_limit_exceeded_total', {
        category,
      });
    }

    return {
      allowed,
      limit: maxRequests,
      remaining,
      resetTime,
      retryAfterSeconds,
    };
  }

  /**
   * Check Load Shedding Pressure
   */
  public checkLoadShedding(): LoadSheddingResult {
    if (!this.config.LOAD_SHEDDING_ENABLED) {
      return { allowed: true, activeConcurrency: this.activeConcurrency };
    }

    // 1. Check HTTP concurrency pressure
    if (this.activeConcurrency >= this.config.LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS) {
      telemetryService.incrementCounter('load_shedding_rejected_total', {
        reason: 'CONCURRENCY_EXCEEDED',
      });
      return {
        allowed: false,
        reason: 'CONCURRENCY_EXCEEDED',
        activeConcurrency: this.activeConcurrency,
      };
    }

    // 2. Check PostgreSQL pool waiting queue saturation
    const dbStatus = db.getStatus();
    const waitingQueue = dbStatus.waitingClients ?? 0;
    if (waitingQueue >= this.config.LOAD_SHEDDING_DB_WAITING_THRESHOLD) {
      telemetryService.incrementCounter('load_shedding_rejected_total', {
        reason: 'DB_POOL_EXHAUSTED',
      });
      return {
        allowed: false,
        reason: 'DB_POOL_EXHAUSTED',
        activeConcurrency: this.activeConcurrency,
      };
    }

    return { allowed: true, activeConcurrency: this.activeConcurrency };
  }

  /**
   * Concurrency tracking hooks
   */
  public incrementConcurrency(): number {
    this.activeConcurrency++;
    return this.activeConcurrency;
  }

  public decrementConcurrency(): number {
    this.activeConcurrency = Math.max(0, this.activeConcurrency - 1);
    return this.activeConcurrency;
  }

  public getActiveConcurrency(): number {
    return this.activeConcurrency;
  }

  private getMaxRequestsForCategory(category: RateLimitCategory): number {
    switch (category) {
      case 'AUTH':
        return this.config.RATE_LIMIT_AUTH_MAX;
      case 'MUTATION':
        return this.config.RATE_LIMIT_MUTATION_MAX;
      case 'API_KEY':
        return this.config.RATE_LIMIT_API_KEY_MAX;
      case 'GLOBAL':
      default:
        return this.config.RATE_LIMIT_GLOBAL_MAX;
    }
  }

  /**
   * In-Memory LRU/TTL fallback with bounded size
   */
  private incrementInMemory(key: string, windowMs: number): number {
    const now = Date.now();

    // Clean up expired entries if cache is growing large
    if (this.inMemoryStore.size >= this.maxInMemoryEntries) {
      for (const [k, v] of this.inMemoryStore.entries()) {
        if (v.expiresAt <= now) {
          this.inMemoryStore.delete(k);
        }
      }
    }

    const entry = this.inMemoryStore.get(key);
    if (!entry || entry.expiresAt <= now) {
      this.inMemoryStore.set(key, { count: 1, expiresAt: now + windowMs });
      return 1;
    }

    entry.count += 1;
    return entry.count;
  }

  public reset(): void {
    this.inMemoryStore.clear();
    this.activeConcurrency = 0;
  }
}

export const rateLimitService = new RateLimitService();
