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

  public computeFingerprint(method: string, path: string, body: unknown): string {
    const canonicalBody = this.canonicalize(body ?? {});
    const payload = `${method.toUpperCase()}:${path}:${JSON.stringify(canonicalBody)}`;
    return crypto.createHash('sha256').update(payload).digest('hex');
  }

  private getStorageKey(userId: string, idempotencyKey: string): string {
    return `idempotency:${userId}:${idempotencyKey}`;
  }

  public async acquireKey(
    userId: string,
    key: string,
    fingerprint: string,
    ttlSeconds: number = 86400
  ): Promise<AcquireResult> {
    const storageKey = this.getStorageKey(userId, key);

    const inFlightRecord: StoredIdempotencyRecord = {
      status: 'PROCESSING',
      userId,
      key,
      fingerprint,
      startedAt: Date.now(),
    };

    try {
      // Step 1: ATOMIC ACQUISITION
      // Will return true only if the key did NOT exist and was successfully set.
      const acquired = await this.redisClient.setNX(storageKey, JSON.stringify(inFlightRecord), 60);
      
      if (acquired) {
        return { status: 'ACQUIRED' };
      }

      // Step 2: KEY ALREADY EXISTS -> Retrieve and check it
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
      
      // If we got here, it means setNX failed because it existed, but then GET returned null
      // (perhaps it expired in the exact millisecond between). We will just claim we couldn't get it.
      return {
        status: 'CONFLICT',
        message: 'Idempotency state inconsistency - please retry',
      };
      
    } catch (err) {
      logger.warn('Redis error in IdempotencyService acquireKey; failing closed to prevent duplicate transactions', {
        storageKey,
        error: (err as Error).message,
      });

      // NO MEMORY FALLBACK FOR ATOMIC IDEMPOTENCY
      // If Redis is down, we must safely REJECT the mutation so it is not duplicated.
      throw new Error('Idempotency unavailable due to backend coordination failure. Please retry later.');
    }
  }

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
      logger.error('Redis error in completeKey; failed to persist idempotency completion state', {
        storageKey,
        error: (err as Error).message,
      });
      // We do not fallback to memory here because cross-instance consistency is paramount.
    }
  }

  public async releaseKey(userId: string, key: string): Promise<void> {
    const storageKey = this.getStorageKey(userId, key);
    try {
      await this.redisClient.del(storageKey);
    } catch (err) {
      logger.error('Redis error in releaseKey', { error: (err as Error).message });
    }
  }

  public resetMemoryStore(): void {
    this.memoryFallback.clear();
  }
}

export const idempotencyService = new IdempotencyService();
