import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { authRateLimiter } from '../src/middleware/auth';
import { redis } from '../src/config/redis';
import { AppError } from '../src/middleware/errorHandler';

describe('Redis-backed Authentication Rate Limiter', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  let testIpCounter = 1;
  beforeEach(async () => {
    await redis.close();
    await redis.connect();
    
    const testIp = `192.168.1.${testIpCounter++}`;
    req = { ip: testIp, socket: { remoteAddress: testIp } as any };
    res = {};
    next = vi.fn();
    
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. normal requests: allows request below threshold', async () => {
    const middleware = authRateLimiter(2, 60000);
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenCalledWith(); // Called without error
  });

  it('2. threshold behavior & rejection after threshold', async () => {
    const middleware = authRateLimiter(2, 60000);
    
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith();
    
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith();
    
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith(expect.any(AppError));
    
    const lastArg = (next as any).mock.lastCall[0];
    expect(lastArg.statusCode).toBe(429);
    expect(lastArg.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('3. expiration/window reset', async () => {
    const middleware = authRateLimiter(1, 1000);
    
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith(); // 1st allowed
    
    await middleware(req as Request, res as Response, next);
    expect((next as any).mock.lastCall[0].statusCode).toBe(429); // 2nd blocked

    // Advance time to next window
    vi.advanceTimersByTime(1100);
    
    // Simulate what happens in real life (windowId changes based on Date.now())
    await middleware(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith(); // Allowed again
  });

  it('4. multiple simulated backend instances sharing the same Redis limiter', async () => {
    const middlewareInstanceA = authRateLimiter(2, 60000);
    const middlewareInstanceB = authRateLimiter(2, 60000); // Different instances, same redis connection in mock

    await middlewareInstanceA(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith();

    await middlewareInstanceB(req as Request, res as Response, next);
    expect(next).toHaveBeenLastCalledWith();

    await middlewareInstanceA(req as Request, res as Response, next);
    expect((next as any).mock.lastCall[0].statusCode).toBe(429);
  });

  it('5. Redis unavailable behavior (fail-open safety)', async () => {
    // Simulate redis outage
    vi.spyOn(redis, 'incr').mockRejectedValueOnce(new Error('Redis Connection Error'));
    
    const middleware = authRateLimiter(1, 60000);
    await middleware(req as Request, res as Response, next);
    
    // Should call next() without error (fail-open)
    expect(next).toHaveBeenCalledWith();
  });
});
