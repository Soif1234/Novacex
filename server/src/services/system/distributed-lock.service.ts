import crypto from 'crypto';
import { redis, IRedisConnection } from '../../config/redis';
import { logger } from '../../config/logger';

export class DistributedLockService {
  constructor(private redisClient: IRedisConnection = redis) {}

  public async acquireLock(lockKey: string, ttlSeconds: number): Promise<string | null> {
    const token = crypto.randomBytes(16).toString('hex');
    
    try {
      const acquired = await this.redisClient.setNX(lockKey, token, ttlSeconds);
      if (acquired) {
        return token;
      }
      return null;
    } catch (err) {
      logger.error('Failed to acquire distributed lock', { lockKey, error: (err as Error).message });
      return null;
    }
  }

  public async releaseLock(lockKey: string, token: string): Promise<boolean> {
    try {
      const currentToken = await this.redisClient.get(lockKey);
      if (currentToken === token) {
        await this.redisClient.del(lockKey);
        return true;
      }
      return false; // Lock expired or owned by someone else
    } catch (err) {
      logger.error('Failed to release distributed lock', { lockKey, error: (err as Error).message });
      return false;
    }
  }
}

export const distributedLockService = new DistributedLockService();
