import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RedisClient } from '../src/config/redis';
import { loadConfig } from '../src/config/env';
import { IdempotencyService } from '../src/services/system/idempotency.service';

describe('Phase 8.4: Redis Connection Reliability & Reconnect Fallback Unit Tests', () => {
  let redisClient: RedisClient;

  beforeEach(() => {
    const testConfig = loadConfig({
      REDIS_RECONNECT_MAX_RETRIES: 4,
      REDIS_RECONNECT_BASE_DELAY_MS: 50,
      REDIS_RECONNECT_MAX_DELAY_MS: 300,
      REDIS_CONNECT_TIMEOUT_MS: 1000,
    });
    redisClient = new RedisClient(testConfig);
  });

  afterEach(async () => {
    if (redisClient) {
      await redisClient.close();
    }
  });

  it('1. Connects initially and reports REDIS_CONNECTED mode with active configuration', async () => {
    await redisClient.connect();

    const status = redisClient.getStatus();
    expect(status.connected).toBe(true);
    expect(status.mode).toBe('REDIS_CONNECTED');
    expect(status.reconnectAttempts).toBe(0);
    expect(status.config?.maxRetries).toBe(4);
    expect(status.config?.baseDelayMs).toBe(50);

    const health = await redisClient.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.fallbackMode).toBe(false);
  });

  it('2. Switches to in-memory fallback upon disconnect and performs read/write operations seamlessly', async () => {
    await redisClient.connect();

    // Trigger simulated disconnect
    redisClient.triggerDisconnect?.(new Error('ECONNRESET connection dropped'));

    const status = redisClient.getStatus();
    expect(status.connected).toBe(false);
    expect(status.mode).toBe('FALLBACK_MEMORY');
    expect(status.reconnectAttempts).toBe(1);

    // Health report reflects degraded fallback mode
    const health = await redisClient.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.fallbackMode).toBe(true);

    // Operations succeed in fallback mode without crashing
    await redisClient.set('test:key:1', 'val_fallback', 60);
    const val = await redisClient.get('test:key:1');
    expect(val).toBe('val_fallback');

    const count = await redisClient.incr('test:counter', 60);
    expect(count).toBe(1);
    const count2 = await redisClient.incr('test:counter', 60);
    expect(count2).toBe(2);

    const deleted = await redisClient.del('test:key:1');
    expect(deleted).toBe(1);
    expect(await redisClient.get('test:key:1')).toBeNull();
  });

  it('3. Successfully reconnects and restores REDIS_CONNECTED mode', async () => {
    await redisClient.connect();
    redisClient.triggerDisconnect?.(new Error('Temporary network partition'));

    expect(redisClient.getStatus().mode).toBe('FALLBACK_MEMORY');

    // Trigger successful reconnection
    await redisClient.triggerReconnect?.();

    const restoredStatus = redisClient.getStatus();
    expect(restoredStatus.connected).toBe(true);
    expect(restoredStatus.mode).toBe('REDIS_CONNECTED');
    expect(restoredStatus.reconnectAttempts).toBe(0);

    const health = await redisClient.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.fallbackMode).toBe(false);
  });

  it('4. Reconnect backoff stops after reaching maxRetries without infinite aggressive loop', async () => {
    vi.useFakeTimers();

    await redisClient.connect();

    // Trigger persistent failure
    redisClient.setSimulatedFailure(true);

    // Step through 4 retries
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(500);
    }

    const status = redisClient.getStatus();
    expect(status.reconnectAttempts).toBeLessThanOrEqual(4);
    expect(status.mode).toBe('FALLBACK_MEMORY');

    vi.useRealTimers();
  });

  it('5. Graceful shutdown clears timers and marks client DISCONNECTED', async () => {
    await redisClient.connect();
    redisClient.triggerDisconnect?.(new Error('Transient drop'));

    await redisClient.close();

    const status = redisClient.getStatus();
    expect(status.connected).toBe(false);
    expect(status.mode).toBe('DISCONNECTED');
  });

  it('6. IdempotencyService operates flawlessly through Redis disconnect and recovery', async () => {
    const idempotencyService = new IdempotencyService(redisClient);
    await redisClient.connect();

    const fingerprint = idempotencyService.computeFingerprint('POST', '/api/v1/spot/orders', { qty: '10' });

    // 1. Acquire key when Redis connected
    const acquire1 = await idempotencyService.acquireKey('user-test-1', 'idem-key-84', fingerprint);
    expect(acquire1.status).toBe('ACQUIRED');

    await idempotencyService.completeKey('user-test-1', 'idem-key-84', fingerprint, 201, { orderId: 'ord_84' });

    // 2. Trigger Redis disconnect
    redisClient.triggerDisconnect?.(new Error('Redis broker failed'));

    // 3. Retry duplicate request during Redis outage -> cache HIT from in-memory fallback
    const acquire2 = await idempotencyService.acquireKey('user-test-1', 'idem-key-84', fingerprint);
    expect(acquire2.status).toBe('HIT');
    if (acquire2.status === 'HIT') {
      expect(acquire2.statusCode).toBe(201);
      expect(acquire2.body.orderId).toBe('ord_84');
    }

    // 4. Conflicting payload during outage is still rejected with CONFLICT
    const differentFingerprint = idempotencyService.computeFingerprint('POST', '/api/v1/spot/orders', { qty: '99' });
    const conflictResult = await idempotencyService.acquireKey('user-test-1', 'idem-key-84', differentFingerprint);
    expect(conflictResult.status).toBe('CONFLICT');
  });
});
