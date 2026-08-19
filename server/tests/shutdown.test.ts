import { describe, it, expect, vi } from 'vitest';
import { stopServer } from '../src/server';
import { db } from '../src/config/database';
import { redis } from '../src/config/redis';

describe('Graceful Shutdown (server/src/server.ts)', () => {
  it('1. Drains database and Redis connections on shutdown', async () => {
    const dbCloseSpy = vi.spyOn(db, 'close').mockResolvedValue();
    const redisCloseSpy = vi.spyOn(redis, 'close').mockResolvedValue();

    await stopServer();

    expect(dbCloseSpy).toHaveBeenCalled();
    expect(redisCloseSpy).toHaveBeenCalled();
  });
});
