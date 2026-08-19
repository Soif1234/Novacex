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
    expect(config.REDIS_PORT).toBe(6379);
  });

  it('2. Supports configuration overrides', () => {
    const config = loadConfig({
      PORT: 5001,
      NODE_ENV: 'test',
      DB_NAME: 'test_mallick_db'
    });
    expect(config.PORT).toBe(5001);
    expect(config.NODE_ENV).toBe('test');
    expect(config.DB_NAME).toBe('test_mallick_db');
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
