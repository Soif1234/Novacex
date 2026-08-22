import crypto from 'crypto';
import { redis, IRedisConnection } from '../../config/redis';
import { logger } from '../../config/logger';

export interface StoredIdempotencyRecord {
  status: 'PROCESSING' | 'COMPLETED';
  userId: string;
  key: string;
  fingerprint: string;
  statusCode?: number;
  body?: any;
  headers?: Record<string, string>;
  startedAt: number;
  completedAt?: number;
}

export type AcquireResult =
  | { status: 'ACQUIRED' }
  | { status: 'HIT'; statusCode: number; body: any; headers?: Record<string, string> }
  | { status: 'CONFLICT'; message: string }
  | { status: 'PROCESSING'; message: string };

export class IdempotencyService {
  private memoryFallback = new Map<string, { record: StoredIdempotencyRecord; expiresAt: number }>();

  constructor(private redisClient: IRedisConnection = redis) {}

  /**
   * Sort object keys recursively to produce a canonical deterministic JSON string
   */
  public canonicalize(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') {
      return obj;
    }
    if (Array.isArray(obj)) {
      return obj.map(item => this.canonicalize(item));
    }
    const sortedKeys = Object.keys(obj as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = this.canonicalize((obj as Record<string, unknown>)[key]);
    }
    return result;
  }

  /**
   * Compute a deterministic SHA-256 request fingerprint
   */
  public computeFingerprint(method: string, path: string, body: unknown): string {
    const canonicalBody = this.canonicalize(body ?? {});
    const payload = `${method.toUpperCase()}:${path}:${JSON.stringify(canonicalBody)}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  /**
   * Derive the storage key scoped by user ID
   */
  private getStorageKey(userId: string, idempotencyKey: string): string {
    return `idempotency:${userId}:${idempotencyKey}`;
  }

  /**
   * Attempt to acquire the idempotency key lock or retrieve cached response
   */
  public async acquireKey(
    userId: string,
    key: string,
    fingerprint: string,
    ttlSeconds: number = 86400
  ): Promise<AcquireResult> {
    const storageKey = this.getStorageKey(userId, key);

    try {
      // 1. Check existing record from Redis
      const raw = await this.redisClient.get(storageKey);
      if (raw) {
        const record: StoredIdempotencyRecord = JSON.parse(raw);

        if (record.status === 'PROCESSING') {
          if (record.fingerprint !== fingerprint) {
            return {
              status: 'CONFLICT',
              message: 'Idempotency key currently processing for a different request payload',
            };
          }
          return {
            status: 'PROCESSING',
            message: 'A request with this idempotency key is currently processing',
          };
        }

        if (record.status === 'COMPLETED') {
          if (record.fingerprint !== fingerprint) {
            return {
              status: 'CONFLICT',
              message: 'Idempotency key was previously used with a different request payload',
            };
          }
          return {
            status: 'HIT',
            statusCode: record.statusCode || 200,
            body: record.body,
            headers: record.headers,
          };
        }
      }

      // 2. Not found in Redis: Store initial PROCESSING lock (60s in-flight lock)
      const inFlightRecord: StoredIdempotencyRecord = {
        status: 'PROCESSING',
        userId,
        key,
        fingerprint,
        startedAt: Date.now(),
      };

      await this.redisClient.set(storageKey, JSON.stringify(inFlightRecord), 60);
      return { status: 'ACQUIRED' };
    } catch (err) {
      logger.warn('Redis error in IdempotencyService acquireKey; falling back to in-memory store', {
        storageKey,
        error: (err as Error).message,
      });

      return this.acquireMemoryFallback(storageKey, userId, key, fingerprint, ttlSeconds);
    }
  }

  /**
   * Complete the request and store the final response with full TTL
   */
  public async completeKey(
    userId: string,
    key: string,
    fingerprint: string,
    statusCode: number,
    body: any,
    headers?: Record<string, string>,
    ttlSeconds: number = 86400
  ): Promise<void> {
    const storageKey = this.getStorageKey(userId, key);

    const completedRecord: StoredIdempotencyRecord = {
      status: 'COMPLETED',
      userId,
      key,
      fingerprint,
      statusCode,
      body,
      headers,
      startedAt: Date.now(),
      completedAt: Date.now(),
    };

    try {
      await this.redisClient.set(storageKey, JSON.stringify(completedRecord), ttlSeconds);
    } catch (err) {
      logger.warn('Redis error in completeKey; falling back to in-memory store', {
        storageKey,
        error: (err as Error).message,
      });
      this.memoryFallback.set(storageKey, {
        record: completedRecord,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
    }
  }

  /**
   * Release or cancel an in-flight key if processing failed before completing
   */
  public async releaseKey(userId: string, key: string): Promise<void> {
    const storageKey = this.getStorageKey(userId, key);
    try {
      await this.redisClient.del(storageKey);
    } catch {
      this.memoryFallback.delete(storageKey);
    }
  }

  /**
   * In-memory fallback acquisition logic
   */
  private acquireMemoryFallback(
    storageKey: string,
    userId: string,
    key: string,
    fingerprint: string,
    ttlSeconds: number
  ): AcquireResult {
    const now = Date.now();
    const entry = this.memoryFallback.get(storageKey);

    if (entry) {
      if (now > entry.expiresAt) {
        this.memoryFallback.delete(storageKey);
      } else {
        const record = entry.record;
        if (record.status === 'PROCESSING') {
          if (record.fingerprint !== fingerprint) {
            return {
              status: 'CONFLICT',
              message: 'Idempotency key currently processing for a different request payload',
            };
          }
          return {
            status: 'PROCESSING',
            message: 'A request with this idempotency key is currently processing',
          };
        }

        if (record.status === 'COMPLETED') {
          if (record.fingerprint !== fingerprint) {
            return {
              status: 'CONFLICT',
              message: 'Idempotency key was previously used with a different request payload',
            };
          }
          return {
            status: 'HIT',
            statusCode: record.statusCode || 200,
            body: record.body,
            headers: record.headers,
          };
        }
      }
    }

    const inFlightRecord: StoredIdempotencyRecord = {
      status: 'PROCESSING',
      userId,
      key,
      fingerprint,
      startedAt: now,
    };

    this.memoryFallback.set(storageKey, {
      record: inFlightRecord,
      expiresAt: now + 60 * 1000,
    });

    return { status: 'ACQUIRED' };
  }

  public resetMemoryStore(): void {
    this.memoryFallback.clear();
  }
}

export const idempotencyService = new IdempotencyService();
