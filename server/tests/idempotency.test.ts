import { describe, it, expect, beforeEach, vi } from 'vitest';
import { idempotencyMiddleware, requireIdempotency } from '../src/middleware/idempotency';
import { IdempotencyService } from '../src/services/system/idempotency.service';
import { IRedisConnection } from '../src/config/redis';

function createMockReqRes(options: {
  method?: string;
  url?: string;
  body?: any;
  headers?: Record<string, string>;
  userId?: string;
}) {
  let statusCode = 200;
  let responseData: any = null;
  const resHeaders: Record<string, string> = {};

  const headersLower: Record<string, string> = {};
  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      headersLower[k.toLowerCase()] = v;
    }
  }

  const req: any = {
    method: options.method || 'POST',
    originalUrl: options.url || '/api/v1/spot/orders',
    baseUrl: '',
    path: options.url || '/api/v1/spot/orders',
    body: options.body || {},
    headers: headersLower,
    header: (name: string) => headersLower[name.toLowerCase()],
    user: options.userId ? { id: options.userId } : { id: 'user-123' },
    id: 'req-123',
    ip: '127.0.0.1',
  };

  const res: any = {
    statusCode: 200,
    status: (code: number) => {
      statusCode = code;
      res.statusCode = code;
      return res;
    },
    json: (body: any) => {
      responseData = body;
      return res;
    },
    setHeader: (name: string, val: string) => {
      resHeaders[name.toLowerCase()] = val;
    },
    getHeader: (name: string) => resHeaders[name.toLowerCase()],
    on: vi.fn(),
  };

  return {
    req,
    res,
    getStatusCode: () => statusCode,
    getResponseData: () => responseData,
    getResHeaders: () => resHeaders,
  };
}

describe('Phase 8.2: HTTP Idempotency Middleware & Service Unit Tests', () => {
  let idempotencyService: IdempotencyService;
  let mockRedis: IRedisConnection;
  let redisStorage: Map<string, { value: string; expiresAt?: number }>;

  beforeEach(() => {
    redisStorage = new Map();

    mockRedis = {
      connect: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      get: vi.fn(async (key: string) => {
        const item = redisStorage.get(key);
        if (!item) return null;
        if (item.expiresAt && Date.now() > item.expiresAt) {
          redisStorage.delete(key);
          return null;
        }
        return item.value;
      }),
      set: vi.fn(async (key: string, value: string, ttlSeconds?: number) => {
        const expiresAt = ttlSeconds ? Date.now() + ttlSeconds * 1000 : undefined;
        redisStorage.set(key, { value, expiresAt });
      }),
      del: vi.fn(async (key: string) => {
        return redisStorage.delete(key) ? 1 : 0;
      }),
      incr: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: true, latencyMs: 1 }),
      getStatus: vi.fn().mockReturnValue({ connected: true, host: 'localhost', port: 6379 }),
    };

    idempotencyService = new IdempotencyService(mockRedis);
  });

  it('1. Executes normally on first request and stores idempotency record', async () => {
    const middleware = idempotencyMiddleware({ service: idempotencyService });
    const { req, res, getStatusCode, getResponseData, getResHeaders } = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-order-1' },
      body: { symbol: 'BTCUSDT', quantity: '1.5' },
    });

    let downstreamCalled = false;
    await middleware(req, res, () => {
      downstreamCalled = true;
      res.status(201).json({ success: true, orderId: 'ord_1' });
    });

    expect(downstreamCalled).toBe(true);
    expect(getStatusCode()).toBe(201);
    expect(getResponseData().orderId).toBe('ord_1');
    expect(getResHeaders()['x-cache-idempotency']).toBe('MISS');
  });

  it('2. Duplicate request returns original result without re-executing handler', async () => {
    const middleware = idempotencyMiddleware({ service: idempotencyService });

    // Request 1
    const reqRes1 = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-order-2' },
      body: { symbol: 'ETHUSDT', quantity: '10' },
    });

    let executionCount = 0;
    await middleware(reqRes1.req, reqRes1.res, () => {
      executionCount++;
      reqRes1.res.status(201).json({ success: true, orderId: 'ord_eth_10' });
    });

    expect(executionCount).toBe(1);
    expect(reqRes1.getResponseData().orderId).toBe('ord_eth_10');

    // Request 2 (Duplicate with same key & payload)
    const reqRes2 = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-order-2' },
      body: { symbol: 'ETHUSDT', quantity: '10' },
    });

    await middleware(reqRes2.req, reqRes2.res, () => {
      executionCount++;
      reqRes2.res.status(201).json({ success: true, orderId: 'ord_eth_999' });
    });

    expect(executionCount).toBe(1); // Downstream was NOT called again
    expect(reqRes2.getStatusCode()).toBe(201);
    expect(reqRes2.getResponseData().orderId).toBe('ord_eth_10'); // Cached original response
    expect(reqRes2.getResHeaders()['x-cache-idempotency']).toBe('HIT');
  });

  it('3. Rejects request when same key is used with a different payload (conflict detection)', async () => {
    const middleware = idempotencyMiddleware({ service: idempotencyService });

    // Request 1: Buy BTCUSDT
    const reqRes1 = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-order-3' },
      body: { symbol: 'BTCUSDT', quantity: '1.0' },
    });
    await middleware(reqRes1.req, reqRes1.res, () => {
      reqRes1.res.status(201).json({ success: true });
    });

    // Request 2: Buy SOLUSDT with SAME key
    const reqRes2 = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-order-3' },
      body: { symbol: 'SOLUSDT', quantity: '1.0' },
    });

    let downstreamCalled = false;
    await middleware(reqRes2.req, reqRes2.res, () => {
      downstreamCalled = true;
    });

    expect(downstreamCalled).toBe(false);
    expect(reqRes2.getStatusCode()).toBe(409);
    expect(reqRes2.getResponseData().error.code).toBe('IDEMPOTENCY_CONFLICT');
  });

  it('4. Enforces mandatory Idempotency-Key when required', async () => {
    const middleware = requireIdempotency({ service: idempotencyService });

    // Missing header
    const reqResNoKey = createMockReqRes({
      body: { amount: '500' },
    });

    let downstreamCalled = false;
    await middleware(reqResNoKey.req, reqResNoKey.res, () => {
      downstreamCalled = true;
    });

    expect(downstreamCalled).toBe(false);
    expect(reqResNoKey.getStatusCode()).toBe(400);
    expect(reqResNoKey.getResponseData().error.code).toBe('MISSING_IDEMPOTENCY_KEY');

    // Valid header
    const reqResWithKey = createMockReqRes({
      headers: { 'Idempotency-Key': 'wth-key-1' },
      body: { amount: '500' },
    });

    await middleware(reqResWithKey.req, reqResWithKey.res, () => {
      downstreamCalled = true;
      reqResWithKey.res.status(200).json({ success: true, withdrawalId: 'wth_123' });
    });

    expect(downstreamCalled).toBe(true);
    expect(reqResWithKey.getStatusCode()).toBe(200);
    expect(reqResWithKey.getResponseData().withdrawalId).toBe('wth_123');
  });

  it('5. Rejects Idempotency-Key exceeding 255 characters', async () => {
    const middleware = idempotencyMiddleware({ service: idempotencyService });
    const hugeKey = 'a'.repeat(256);

    const reqRes = createMockReqRes({
      headers: { 'Idempotency-Key': hugeKey },
      body: { symbol: 'BTCUSDT' },
    });

    let downstreamCalled = false;
    await middleware(reqRes.req, reqRes.res, () => {
      downstreamCalled = true;
    });

    expect(downstreamCalled).toBe(false);
    expect(reqRes.getStatusCode()).toBe(400);
    expect(reqRes.getResponseData().error.code).toBe('INVALID_IDEMPOTENCY_KEY');
  });

  it('6. Isolates keys by authenticated user (no cross-user collision)', async () => {
    const middleware = idempotencyMiddleware({ service: idempotencyService });

    // User Alpha with shared key
    const reqResUserA = createMockReqRes({
      userId: 'user-alpha',
      headers: { 'Idempotency-Key': 'shared-key-1' },
      body: { symbol: 'BTCUSDT' },
    });

    await middleware(reqResUserA.req, reqResUserA.res, () => {
      reqResUserA.res.status(201).json({ success: true, orderId: 'ord_alpha' });
    });
    expect(reqResUserA.getResponseData().orderId).toBe('ord_alpha');

    // User Beta with SAME shared key
    const reqResUserB = createMockReqRes({
      userId: 'user-beta',
      headers: { 'Idempotency-Key': 'shared-key-1' },
      body: { symbol: 'BTCUSDT' },
    });

    let userBCalled = false;
    await middleware(reqResUserB.req, reqResUserB.res, () => {
      userBCalled = true;
      reqResUserB.res.status(201).json({ success: true, orderId: 'ord_beta' });
    });

    expect(userBCalled).toBe(true);
    expect(reqResUserB.getResponseData().orderId).toBe('ord_beta');
  });

  it('7. Handles concurrent duplicate requests safely (locks in-flight key)', async () => {
    const fingerprint = idempotencyService.computeFingerprint('POST', '/api/v1/spot/orders', { symbol: 'BTCUSDT' });

    const acquire1 = await idempotencyService.acquireKey('user-1', 'key-concurrent-lock', fingerprint);
    expect(acquire1.status).toBe('ACQUIRED');

    const acquire2 = await idempotencyService.acquireKey('user-1', 'key-concurrent-lock', fingerprint);
    expect(acquire2.status).toBe('PROCESSING');
  });

  it('8. Falls back safely to in-memory store when Redis throws an error', async () => {
    const brokenRedis: IRedisConnection = {
      connect: vi.fn(),
      close: vi.fn(),
      get: vi.fn().mockRejectedValue(new Error('Redis connection down')),
      set: vi.fn().mockRejectedValue(new Error('Redis connection down')),
      del: vi.fn().mockRejectedValue(new Error('Redis connection down')),
      incr: vi.fn(),
      healthCheck: vi.fn().mockResolvedValue({ healthy: false, latencyMs: 0 }),
      getStatus: vi.fn().mockReturnValue({ connected: false, host: '', port: 0 }),
    };

    const fallbackService = new IdempotencyService(brokenRedis);
    const middleware = idempotencyMiddleware({ service: fallbackService });

    // Request 1: In-memory fallback
    const reqRes1 = createMockReqRes({
      headers: { 'Idempotency-Key': 'fallback-key' },
      body: { symbol: 'SOLUSDT' },
    });

    let count = 0;
    await middleware(reqRes1.req, reqRes1.res, () => {
      count++;
      reqRes1.res.status(200).json({ success: true, count });
    });

    expect(reqRes1.getResponseData().count).toBe(1);

    // Request 2: Cached in-memory fallback hit
    const reqRes2 = createMockReqRes({
      headers: { 'Idempotency-Key': 'fallback-key' },
      body: { symbol: 'SOLUSDT' },
    });

    await middleware(reqRes2.req, reqRes2.res, () => {
      count++;
    });

    expect(count).toBe(1);
    expect(reqRes2.getStatusCode()).toBe(200);
    expect(reqRes2.getResponseData().count).toBe(1);
    expect(reqRes2.getResHeaders()['x-cache-idempotency']).toBe('HIT');
  });

  it('9. Does not cache 5xx server errors, allowing clean client retries', async () => {
    const middleware = idempotencyMiddleware({ service: idempotencyService });

    // Request 1 fails with 500
    const reqRes1 = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-retry-500' },
      body: { action: 'test' },
    });

    let execCount = 0;
    await middleware(reqRes1.req, reqRes1.res, () => {
      execCount++;
      reqRes1.res.status(500).json({ success: false, error: 'Database timeout' });
    });

    expect(execCount).toBe(1);
    expect(reqRes1.getStatusCode()).toBe(500);

    // Request 2 retry succeeds
    const reqRes2 = createMockReqRes({
      headers: { 'Idempotency-Key': 'key-retry-500' },
      body: { action: 'test' },
    });

    await middleware(reqRes2.req, reqRes2.res, () => {
      execCount++;
      reqRes2.res.status(200).json({ success: true, recovered: true });
    });

    expect(execCount).toBe(2);
    expect(reqRes2.getStatusCode()).toBe(200);
    expect(reqRes2.getResponseData().recovered).toBe(true);
  });
});
