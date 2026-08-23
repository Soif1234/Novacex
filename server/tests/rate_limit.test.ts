import { describe, it, expect, beforeEach, vi } from 'vitest';
import { RateLimitService } from '../src/services/system/rate-limit.service';
import { loadConfig } from '../src/config/env';
import { rateLimiter } from '../src/middleware/rateLimit';
import { loadSheddingMiddleware } from '../src/middleware/loadShedding';
import { db } from '../src/config/database';
import { Request, Response, NextFunction } from 'express';

describe('Phase 8.6: Rate Limiting & Load Shedding Unit Tests', () => {
  let rateLimitService: RateLimitService;
  let mockRedis: any;

  beforeEach(() => {
    mockRedis = {
      incr: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
      getStatus: vi.fn().mockReturnValue({ connected: true, mode: 'REDIS_CONNECTED', host: 'localhost', port: 6379 }),
    };

    const config = loadConfig({
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_GLOBAL_MAX: 5,
      RATE_LIMIT_AUTH_MAX: 3,
      RATE_LIMIT_MUTATION_MAX: 2,
      RATE_LIMIT_WINDOW_MS: 1000,
      LOAD_SHEDDING_ENABLED: true,
      LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS: 2,
      LOAD_SHEDDING_DB_WAITING_THRESHOLD: 3,
    });

    rateLimitService = new RateLimitService(mockRedis, config);
  });

  it('1. IP Rate Limiting: increments quota and rejects request after exceeding limit', async () => {
    mockRedis.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(4); // Exceeds limit of 3 for AUTH

    const res1 = await rateLimitService.checkRateLimit('192.168.1.1', 'AUTH');
    expect(res1.allowed).toBe(true);
    expect(res1.remaining).toBe(2);

    const res2 = await rateLimitService.checkRateLimit('192.168.1.1', 'AUTH');
    expect(res2.allowed).toBe(true);
    expect(res2.remaining).toBe(1);

    const res3 = await rateLimitService.checkRateLimit('192.168.1.1', 'AUTH');
    expect(res3.allowed).toBe(true);
    expect(res3.remaining).toBe(0);

    const res4 = await rateLimitService.checkRateLimit('192.168.1.1', 'AUTH');
    expect(res4.allowed).toBe(false);
    expect(res4.remaining).toBe(0);
    expect(res4.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it('2. User isolation: different users maintain separate rate limit buckets', async () => {
    mockRedis.incr.mockResolvedValue(1);

    const user1 = await rateLimitService.checkRateLimit('usr:user-1', 'MUTATION');
    const user2 = await rateLimitService.checkRateLimit('usr:user-2', 'MUTATION');

    expect(user1.allowed).toBe(true);
    expect(user2.allowed).toBe(true);
    expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('usr:user-1'), expect.any(Number));
    expect(mockRedis.incr).toHaveBeenCalledWith(expect.stringContaining('usr:user-2'), expect.any(Number));
  });

  it('3. In-Memory fallback: continues rate limiting safely if Redis throws error', async () => {
    mockRedis.incr.mockRejectedValue(new Error('Redis connection timed out'));

    // In-memory fallback allows up to 2 for MUTATION
    const r1 = await rateLimitService.checkRateLimit('test-ip', 'MUTATION');
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);

    const r2 = await rateLimitService.checkRateLimit('test-ip', 'MUTATION');
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);

    const r3 = await rateLimitService.checkRateLimit('test-ip', 'MUTATION');
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });

  it('4. Rate Limiting Middleware sets RFC-compliant headers and rejects on violation', async () => {
    mockRedis.incr.mockResolvedValueOnce(10); // Exceeds limit

    const middleware = rateLimiter({ category: 'AUTH', maxRequests: 3 }, rateLimitService);
    const req = { ip: '10.0.0.1', originalUrl: '/api/v1/auth/login' } as Request;
    const headers: Record<string, string> = {};

    const res = {
      setHeader: (k: string, v: string) => {
        headers[k] = v;
      },
    } as unknown as Response;

    let errorResult: any = null;
    await middleware(req, res, (err?: any) => {
      errorResult = err;
    });

    expect(headers['X-RateLimit-Limit']).toBe('3');
    expect(headers['X-RateLimit-Remaining']).toBe('0');
    expect(headers['Retry-After']).toBeDefined();
    expect(errorResult).toBeDefined();
    expect(errorResult.statusCode).toBe(429);
    expect(errorResult.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('5. Load Shedding activates when active HTTP concurrency reaches maximum threshold', () => {
    // Max concurrency configured to 2
    expect(rateLimitService.checkLoadShedding().allowed).toBe(true);

    rateLimitService.incrementConcurrency(); // 1
    expect(rateLimitService.checkLoadShedding().allowed).toBe(true);

    rateLimitService.incrementConcurrency(); // 2 -> threshold reached
    const shedResult = rateLimitService.checkLoadShedding();
    expect(shedResult.allowed).toBe(false);
    expect(shedResult.reason).toBe('CONCURRENCY_EXCEEDED');

    // Decrement -> Graceful Recovery
    rateLimitService.decrementConcurrency();
    expect(rateLimitService.checkLoadShedding().allowed).toBe(true);
  });

  it('6. Load Shedding activates when PostgreSQL pool waiting queue is saturated', () => {
    vi.spyOn(db, 'getStatus').mockReturnValue({
      connected: true,
      poolSize: 10,
      activeConnections: 10,
      idleConnections: 0,
      waitingClients: 16, // Exceeds threshold of 15
    });

    const shedResult = rateLimitService.checkLoadShedding();
    expect(shedResult.allowed).toBe(false);
    expect(shedResult.reason).toBe('DB_POOL_EXHAUSTED');
  });

  it('7. Load Shedding Middleware bypasses health and liveness probe routes', () => {
    const reqLive = { originalUrl: '/api/v1/health/live' } as Request;
    const resLive = {} as Response;
    let nextCalled = false;

    loadSheddingMiddleware(reqLive, resLive, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
  });
});
