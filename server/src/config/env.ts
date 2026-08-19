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
  REDIS_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  SHUTDOWN_TIMEOUT_MS: number;
}

function parseNumber(val: string | undefined, fallback: number, name: string): number {
  if (val === undefined || val.trim() === '') return fallback;
  const num = Number(val);
  if (isNaN(num) || !isFinite(num)) {
    throw new Error(`Invalid numeric environment variable for ${name}: "${val}"`);
  }
  return num;
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
    REDIS_URL: redisUrl,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
    LOG_LEVEL: logLevel as 'debug' | 'info' | 'warn' | 'error',
    SHUTDOWN_TIMEOUT_MS: shutdownTimeout,
    ...overrides
  };

  return config;
}

export const env = loadConfig();
