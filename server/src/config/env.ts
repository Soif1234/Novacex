import dotenv from 'dotenv';
import path from 'path';

// Load .env if present
dotenv.config();

export interface EnvironmentConfig {
  NODE_ENV: 'development' | 'production' | 'test';
  PORT: number;
  HOST: string;
  API_PREFIX: string;
  APP_NAME: string;
  APP_VERSION: string;
  CORS_ORIGIN: string;
  DATABASE_URL: string;
  DB_HOST: string;
  DB_PORT: number;
  DB_NAME: string;
  DB_USER: string;
  DB_PASSWORD: string;
  DB_POOL_MIN: number;
  DB_POOL_MAX: number;
  DB_CONNECTION_TIMEOUT_MS: number;
  DB_IDLE_TIMEOUT_MS: number;
  DB_QUERY_TIMEOUT_MS: number;
  REDIS_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_CONNECT_TIMEOUT_MS: number;
  REDIS_RECONNECT_MAX_RETRIES: number;
  REDIS_RECONNECT_BASE_DELAY_MS: number;
  REDIS_RECONNECT_MAX_DELAY_MS: number;
  RATE_LIMIT_ENABLED: boolean;
  RATE_LIMIT_GLOBAL_MAX: number;
  RATE_LIMIT_AUTH_MAX: number;
  RATE_LIMIT_MUTATION_MAX: number;
  RATE_LIMIT_API_KEY_MAX: number;
  RATE_LIMIT_WINDOW_MS: number;
  LOAD_SHEDDING_ENABLED: boolean;
  LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS: number;
  LOAD_SHEDDING_DB_WAITING_THRESHOLD: number;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  SHUTDOWN_TIMEOUT_MS: number;
  API_KEY_ENCRYPTION_SECRET?: string;
}

function parseNumber(val: string | undefined, fallback: number, name: string): number {
  if (val === undefined || val.trim() === '') return fallback;
  const num = Number(val);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`Invalid numeric environment variable for ${name}: "${val}"`);
  }
  return num;
}

function parseBoolean(val: string | undefined, fallback: boolean): boolean {
  if (val === undefined || val.trim() === '') return fallback;
  return val.toLowerCase() === 'true' || val === '1';
}

export function loadConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
  if (!['development', 'production', 'test'].includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: "${nodeEnv}". Must be 'development', 'production', or 'test'.`);
  }

  const port = parseNumber(process.env.PORT, 4000, 'PORT');
  const dbPort = parseNumber(process.env.DB_PORT, 5432, 'DB_PORT');
  const redisPort = parseNumber(process.env.REDIS_PORT, 6379, 'REDIS_PORT');
  const poolMin = parseNumber(process.env.DB_POOL_MIN, 2, 'DB_POOL_MIN');
  const poolMax = parseNumber(process.env.DB_POOL_MAX, 20, 'DB_POOL_MAX');
  const dbConnTimeout = parseNumber(process.env.DB_CONNECTION_TIMEOUT_MS, 5000, 'DB_CONNECTION_TIMEOUT_MS');
  const dbIdleTimeout = parseNumber(process.env.DB_IDLE_TIMEOUT_MS, 30000, 'DB_IDLE_TIMEOUT_MS');
  const dbQueryTimeout = parseNumber(process.env.DB_QUERY_TIMEOUT_MS, 10000, 'DB_QUERY_TIMEOUT_MS');
  const redisConnectTimeout = parseNumber(process.env.REDIS_CONNECT_TIMEOUT_MS, 3000, 'REDIS_CONNECT_TIMEOUT_MS');
  const redisMaxRetries = parseNumber(process.env.REDIS_RECONNECT_MAX_RETRIES, 10, 'REDIS_RECONNECT_MAX_RETRIES');
  const redisBaseDelay = parseNumber(process.env.REDIS_RECONNECT_BASE_DELAY_MS, 500, 'REDIS_RECONNECT_BASE_DELAY_MS');
  const redisMaxDelay = parseNumber(process.env.REDIS_RECONNECT_MAX_DELAY_MS, 10000, 'REDIS_RECONNECT_MAX_DELAY_MS');
  
  const rateLimitEnabled = parseBoolean(process.env.RATE_LIMIT_ENABLED, nodeEnv !== 'test');
  const rateLimitGlobalMax = parseNumber(process.env.RATE_LIMIT_GLOBAL_MAX, 300, 'RATE_LIMIT_GLOBAL_MAX');
  const rateLimitAuthMax = parseNumber(process.env.RATE_LIMIT_AUTH_MAX, 20, 'RATE_LIMIT_AUTH_MAX');
  const rateLimitMutationMax = parseNumber(process.env.RATE_LIMIT_MUTATION_MAX, 60, 'RATE_LIMIT_MUTATION_MAX');
  const rateLimitApiKeyMax = parseNumber(process.env.RATE_LIMIT_API_KEY_MAX, 120, 'RATE_LIMIT_API_KEY_MAX');
  const rateLimitWindowMs = parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60000, 'RATE_LIMIT_WINDOW_MS');

  const loadSheddingEnabled = parseBoolean(process.env.LOAD_SHEDDING_ENABLED, nodeEnv !== 'test');
  const loadSheddingMaxConcurrent = parseNumber(process.env.LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS, 100, 'LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS');
  const loadSheddingDbWaitingThreshold = parseNumber(process.env.LOAD_SHEDDING_DB_WAITING_THRESHOLD, 15, 'LOAD_SHEDDING_DB_WAITING_THRESHOLD');

  const shutdownTimeout = parseNumber(process.env.SHUTDOWN_TIMEOUT_MS, 10000, 'SHUTDOWN_TIMEOUT_MS');

  const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: "${logLevel}". Must be 'debug', 'info', 'warn', or 'error'.`);
  }

  const dbHost = process.env.DB_HOST || 'localhost';
  const dbName = process.env.DB_NAME || 'mallick_exchange';
  const dbUser = process.env.DB_USER || 'mallick';
  const dbPassword = process.env.DB_PASSWORD || 'mallick_pass';
  const databaseUrl = process.env.DATABASE_URL || `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisUrl = process.env.REDIS_URL || `redis://${redisHost}:${redisPort}`;

  const config: EnvironmentConfig = {
    NODE_ENV: nodeEnv as 'development' | 'production' | 'test',
    PORT: port,
    HOST: process.env.HOST || '0.0.0.0',
    API_PREFIX: process.env.API_PREFIX || '/api/v1',
    APP_NAME: process.env.APP_NAME || 'mallick-exchange-backend',
    APP_VERSION: process.env.APP_VERSION || '1.0.0',
    CORS_ORIGIN: process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000',
    DATABASE_URL: databaseUrl,
    DB_HOST: dbHost,
    DB_PORT: dbPort,
    DB_NAME: dbName,
    DB_USER: dbUser,
    DB_PASSWORD: dbPassword,
    DB_POOL_MIN: poolMin,
    DB_POOL_MAX: poolMax,
    DB_CONNECTION_TIMEOUT_MS: dbConnTimeout,
    DB_IDLE_TIMEOUT_MS: dbIdleTimeout,
    DB_QUERY_TIMEOUT_MS: dbQueryTimeout,
    REDIS_URL: redisUrl,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
    REDIS_CONNECT_TIMEOUT_MS: redisConnectTimeout,
    REDIS_RECONNECT_MAX_RETRIES: redisMaxRetries,
    REDIS_RECONNECT_BASE_DELAY_MS: redisBaseDelay,
    REDIS_RECONNECT_MAX_DELAY_MS: redisMaxDelay,
    RATE_LIMIT_ENABLED: rateLimitEnabled,
    RATE_LIMIT_GLOBAL_MAX: rateLimitGlobalMax,
    RATE_LIMIT_AUTH_MAX: rateLimitAuthMax,
    RATE_LIMIT_MUTATION_MAX: rateLimitMutationMax,
    RATE_LIMIT_API_KEY_MAX: rateLimitApiKeyMax,
    RATE_LIMIT_WINDOW_MS: rateLimitWindowMs,
    LOAD_SHEDDING_ENABLED: loadSheddingEnabled,
    LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS: loadSheddingMaxConcurrent,
    LOAD_SHEDDING_DB_WAITING_THRESHOLD: loadSheddingDbWaitingThreshold,
    LOG_LEVEL: logLevel as 'debug' | 'info' | 'warn' | 'error',
    SHUTDOWN_TIMEOUT_MS: shutdownTimeout,
    API_KEY_ENCRYPTION_SECRET: process.env.API_KEY_ENCRYPTION_SECRET || undefined,
    ...overrides
  };

  return config;
}

export const env = loadConfig();
