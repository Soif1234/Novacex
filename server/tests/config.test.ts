import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config/env';

describe('Backend Configuration (server/src/config/env.ts)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('1. Loads default configuration with sensible defaults', () => {
    const config = loadConfig();
    expect(config.NODE_ENV).toBeDefined();
    expect(config.PORT).toBe(4000);
    expect(config.API_PREFIX).toBe('/api/v1');
    expect(config.APP_NAME).toBe('mallick-exchange-backend');
    expect(config.DB_HOST).toBe('localhost');
    expect(config.DB_PORT).toBe(5432);
    expect(config.DB_POOL_MIN).toBe(2);
    expect(config.DB_POOL_MAX).toBe(20);
    expect(config.DB_CONNECTION_TIMEOUT_MS).toBe(5000);
    expect(config.DB_IDLE_TIMEOUT_MS).toBe(30000);
    expect(config.DB_QUERY_TIMEOUT_MS).toBe(10000);
    expect(config.REDIS_PORT).toBe(6379);
    expect(config.REDIS_CONNECT_TIMEOUT_MS).toBe(3000);
    expect(config.REDIS_RECONNECT_MAX_RETRIES).toBe(10);
    expect(config.REDIS_RECONNECT_BASE_DELAY_MS).toBe(500);
    expect(config.REDIS_RECONNECT_MAX_DELAY_MS).toBe(10000);
    expect(config.RATE_LIMIT_ENABLED).toBe(false); // false in test, true in production
    expect(config.RATE_LIMIT_GLOBAL_MAX).toBe(300);
    expect(config.RATE_LIMIT_AUTH_MAX).toBe(20);
    expect(config.RATE_LIMIT_MUTATION_MAX).toBe(60);
    expect(config.RATE_LIMIT_API_KEY_MAX).toBe(120);
    expect(config.RATE_LIMIT_WINDOW_MS).toBe(60000);
    expect(config.LOAD_SHEDDING_ENABLED).toBe(false); // false in test, true in production
    expect(config.LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS).toBe(100);
    expect(config.LOAD_SHEDDING_DB_WAITING_THRESHOLD).toBe(15);
  });

  it('2. Supports configuration overrides', () => {
    const config = loadConfig({
      PORT: 5001,
      NODE_ENV: 'test',
      DB_NAME: 'test_mallick_db',
      DB_POOL_MAX: 50,
      DB_QUERY_TIMEOUT_MS: 3000,
      REDIS_RECONNECT_MAX_RETRIES: 5,
      RATE_LIMIT_GLOBAL_MAX: 500,
      LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS: 200,
    });
    expect(config.PORT).toBe(5001);
    expect(config.NODE_ENV).toBe('test');
    expect(config.DB_NAME).toBe('test_mallick_db');
    expect(config.DB_POOL_MAX).toBe(50);
    expect(config.DB_QUERY_TIMEOUT_MS).toBe(3000);
    expect(config.REDIS_RECONNECT_MAX_RETRIES).toBe(5);
    expect(config.RATE_LIMIT_GLOBAL_MAX).toBe(500);
    expect(config.LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS).toBe(200);
  });

  it('3. Throws on invalid numeric environment variables', () => {
    process.env.PORT = 'not-a-number';
    expect(() => loadConfig()).toThrow(/Invalid numeric environment variable/i);
  });

  it('4. Throws on invalid NODE_ENV', () => {
    process.env.NODE_ENV = 'invalid_environment';
    expect(() => loadConfig()).toThrow(/Invalid NODE_ENV/i);
  });

  it('5. Throws on invalid LOG_LEVEL', () => {
    process.env.LOG_LEVEL = 'verbose_unknown';
    expect(() => loadConfig()).toThrow(/Invalid LOG_LEVEL/i);
  });
});
