import dotenv from 'dotenv';
import path from 'path';
import { ethers } from 'ethers';

// Load .env if present
dotenv.config();

export interface EnvironmentConfig {
  CRYPTO_WITHDRAWALS_ENABLED: boolean;
  /** 6E-4C-2: networks eligible for deposit sweeping (CSV, uppercase). */
  CUSTODY_SWEEPABLE_NETWORKS: string;
  /** 6E-4C-2: per-asset ERC20 sweep minimum in token base units (CSV "ASSET=UNITS"). */
  CUSTODY_SWEEP_MIN_TOKEN_UNITS: string;
  /** 6E-4C-2: broadcast artifacts older than this are probed and escalated. */
  CUSTODY_SWEEP_STALE_BROADCAST_MINUTES: number;
  /** 6E-4C-2: stuck sweep recovery threshold in minutes (queue mechanics). */
  CUSTODY_SWEEP_RECOVERY_TIMEOUT_MINUTES: number;
  /**
   * Phase 11K — manual Safe mode. The authorized sender address for customer
   * withdrawals and treasury transfers. This is a cold EOA / MetaMask address
   * that the backend NEVER signs for. The backend only reads this address to
   * verify on-chain transactions (from == CUSTODY_HOT_WALLET_ADDRESS).
   * Set to empty string / undefined in non-manual environments.
   */
  CUSTODY_HOT_WALLET_ADDRESS: string;
  /**
   * Phase 11K — expected chain ID for the custody network. Used by manual
   * on-chain verification to reject transactions on the wrong chain.
   * Default: 1 (mainnet) in production, 11155111 (Sepolia) otherwise.
   */
  CUSTODY_CHAIN_ID: number;
  NODE_ENV: 'development' | 'staging' | 'production' | 'test';
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
  DB_SSL_MODE: 'auto' | 'require' | 'disable';
  DB_SSL_REJECT_UNAUTHORIZED: boolean;
  DB_CA_CERT?: string;
  REDIS_URL: string;
  REDIS_HOST: string;
  REDIS_PORT: number;
  REDIS_PASSWORD?: string;
  REDIS_CONNECT_TIMEOUT_MS: number;
  REDIS_RECONNECT_MAX_RETRIES: number;
  REDIS_RECONNECT_BASE_DELAY_MS: number;
  REDIS_RECONNECT_MAX_DELAY_MS: number;
  REDIS_SSL_REJECT_UNAUTHORIZED: boolean;
  REDIS_CA_CERT?: string;

  HYPERLIQUID_ENV: 'testnet' | 'mainnet';
  HYPERLIQUID_REST_URL: string;
  HYPERLIQUID_WS_URL: string;
  HYPERLIQUID_AGENT_PRIVATE_KEY: string;
  HYPERLIQUID_ACCOUNT_ADDRESS: string;
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
  AUTO_MIGRATE: boolean;
  EXTERNAL_MARKET_DATA_ENABLED: boolean;
  EXTERNAL_MARKET_DATA_URL: string;
  EXTERNAL_MARKET_DATA_FUTURES_URL: string;
  EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS: number;
  NOTIFICATION_PROVIDER?: string;
  SENDGRID_API_KEY?: string;
  NOTIFICATION_FROM_EMAIL?: string;
  NOTIFICATION_FROM_NAME?: string;
  /**
   * Phase 9.2: custody abstraction layer master switch.
   * MUST remain false until the real-money custody system is fully built
   * (Phase 9.12/9.13). When false, the custody service fails closed and the
   * mock provider is never wired to any financial state.
   */
  CUSTODY_ENABLED: boolean;
  CUSTODY_PROVIDER?: 'mock' | 'local_kms' | 'kms' | 'manual_safe';
  CUSTODY_KMS_KEY_ID?: string;
  CUSTODY_EVM_RPC_URL?: string;
  CUSTODY_KMS_REGION?: string;
  CUSTODY_FACTORY_ADDRESS?: string;
  CUSTODY_IMPLEMENTATION_ADDRESS?: string;
  CUSTODY_INIT_CODE_HASH?: string;
  /**
   * Phase 9.4: blockchain monitoring master switch.
   * MUST remain false by default. Blockchain monitoring workers stay inert
   * (no network) unless an explicit source URL is configured below.
   */
  BLOCKCHAIN_MONITORING_ENABLED: boolean;
  DEPOSIT_CREDITING_ENABLED: boolean;
  /** Ethereum JSON-RPC URL (e.g. Infura/Alchemy). Empty = disabled. */
  ETHEREUM_RPC_URL: string;
  /** Bitcoin API base URL (e.g. Mempool.space / Blockstream). Empty = disabled. */
  BITCOIN_API_URL: string;
  /** Poll interval for the blockchain monitor worker (ms). */
  BLOCKCHAIN_MONITOR_POLL_INTERVAL_MS: number;
  /** Poll interval for the confirmation worker (ms). */
  BLOCKCHAIN_CONFIRMATION_POLL_INTERVAL_MS: number;
  /** Phase 9.7: High-value withdrawal threshold string */
  WITHDRAWAL_REVIEW_THRESHOLD?: string;
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

/**
 * Phase 15C verified Sepolia test addresses.
 * A production process MUST NEVER start with any of these.
 */
export const SEPOLIA_TEST_ADDRESSES: ReadonlySet<string> = new Set([
  '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95'.toLowerCase(), // Sepolia Hot Wallet
  '0x31c5a0946fde4dD32C9da92f8c035b4A17fC1737'.toLowerCase(), // Sepolia Factory
  '0xCd7CAEF9a5237A82E48Ce1790AfFB57878847fd9'.toLowerCase(), // Sepolia Forwarder Implementation
  '0xe406889DAFCBE9F6B2F0E31c7d06aF113BFae262'.toLowerCase(), // Sepolia Forwarder Proxy
  '0x0c90608af5A365139FCa9FA31E326b6394E8FA9B'.toLowerCase(), // Sepolia Treasury Safe
  '0xbAD827522AaadCEC41850E6bbFBCa6201B1fA9e0'.toLowerCase(), // Sepolia Deployer
]);

/**
 * Standard Hardhat / Anvil / Ganache test accounts & fixtures.
 * A production process MUST NEVER start with any of these.
 */
export const KNOWN_TEST_FIXTURES: ReadonlySet<string> = new Set([
  '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'.toLowerCase(), // Hardhat #0
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'.toLowerCase(), // Hardhat #1
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'.toLowerCase(), // Hardhat #2
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906'.toLowerCase(), // Hardhat #3
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'.toLowerCase(), // Hardhat #4
  '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc'.toLowerCase(), // Hardhat #5
  '0x976EA74026E726554dB657fA54763abd0C3a0aa9'.toLowerCase(), // Hardhat #6
  '0x14dC79964da2C08b23698B3D3cc7Ca32193d9955'.toLowerCase(), // Hardhat #7
  '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f'.toLowerCase(), // Hardhat #8
  '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720'.toLowerCase(), // Hardhat #9
  '0x000000000000000000000000000000000000dEaD'.toLowerCase(), // Dead address
  '0x0000000000000000000000000000000000000000'.toLowerCase(), // Zero address
]);

/**
 * Phase 15D-2 — CRIT-02 Remediation: Production Custody Configuration Guard.
 *
 * Enforces unbypassable fail-closed validation for Ethereum Mainnet custody:
 * 1. Provider must be manual_safe
 * 2. Chain ID must be 1 (Ethereum Mainnet)
 * 3. Addresses must be non-empty, valid checksummed EVM addresses
 * 4. Addresses cannot be zero, placeholders, repeated-byte test fixtures,
 *    Sepolia test addresses, or known development fixtures
 * 5. Relational isolation: Factory != Implementation, Hot Wallet != Factory,
 *    Hot Wallet != Implementation
 * 6. Init code hash must be non-empty, 32-byte hex, non-zero, and match the
 *    expected CREATE2 initCodeHash computed from Implementation Address
 * 7. RPC endpoints cannot point to localhost / loopback
 */
export function validateProductionCustodyConfig(config: EnvironmentConfig): void {
  // 1. Provider validation
  if (config.CUSTODY_PROVIDER !== 'manual_safe') {
    throw new Error(
      `Production custody configuration error: CUSTODY_PROVIDER must be 'manual_safe' in production (found "${config.CUSTODY_PROVIDER}")`
    );
  }

  // 2. Chain ID validation
  if (config.CUSTODY_CHAIN_ID !== 1) {
    throw new Error(
      `Production custody configuration error: CUSTODY_CHAIN_ID must be 1 (Ethereum Mainnet) in production (found ${config.CUSTODY_CHAIN_ID})`
    );
  }

  // Helper for address validation
  const validateAddress = (fieldName: string, address: string | undefined): string => {
    if (!address || typeof address !== 'string' || address.trim() === '') {
      throw new Error(`Production custody configuration error: ${fieldName} is missing or empty`);
    }

    const trimmed = address.trim();

    if (
      trimmed.includes('...') ||
      trimmed.toUpperCase().includes('TODO') ||
      trimmed.toUpperCase().includes('PLACEHOLDER') ||
      trimmed.toUpperCase().includes('YOUR_ADDRESS')
    ) {
      throw new Error(`Production custody configuration error: ${fieldName} is a placeholder ("${trimmed}")`);
    }

    if (!ethers.isAddress(trimmed)) {
      throw new Error(`Production custody configuration error: ${fieldName} is not a valid EVM address ("${trimmed}")`);
    }

    const normalized = ethers.getAddress(trimmed);
    const lower = normalized.toLowerCase();

    if (normalized === ethers.ZeroAddress || lower === '0x0000000000000000000000000000000000000000') {
      throw new Error(`Production custody configuration error: ${fieldName} cannot be the zero address`);
    }

    if (/^0x([0-9a-fA-F])\1{39}$/.test(lower)) {
      throw new Error(`Production custody configuration error: ${fieldName} is a repeated-byte test fixture ("${trimmed}")`);
    }

    if (SEPOLIA_TEST_ADDRESSES.has(lower)) {
      throw new Error(`Production custody configuration error: ${fieldName} matches known Sepolia test address ("${trimmed}")`);
    }

    if (KNOWN_TEST_FIXTURES.has(lower)) {
      throw new Error(`Production custody configuration error: ${fieldName} matches known test fixture address ("${trimmed}")`);
    }

    return normalized;
  };

  const hotWallet = validateAddress('CUSTODY_HOT_WALLET_ADDRESS', config.CUSTODY_HOT_WALLET_ADDRESS);
  const factory = validateAddress('CUSTODY_FACTORY_ADDRESS', config.CUSTODY_FACTORY_ADDRESS);
  const implementation = validateAddress('CUSTODY_IMPLEMENTATION_ADDRESS', config.CUSTODY_IMPLEMENTATION_ADDRESS);

  // 3. Relational isolation checks
  if (factory === implementation) {
    throw new Error(
      `Production custody configuration error: CUSTODY_FACTORY_ADDRESS and CUSTODY_IMPLEMENTATION_ADDRESS cannot be identical ("${factory}")`
    );
  }
  if (hotWallet === factory) {
    throw new Error(
      `Production custody configuration error: CUSTODY_HOT_WALLET_ADDRESS and CUSTODY_FACTORY_ADDRESS cannot be identical ("${hotWallet}")`
    );
  }
  if (hotWallet === implementation) {
    throw new Error(
      `Production custody configuration error: CUSTODY_HOT_WALLET_ADDRESS and CUSTODY_IMPLEMENTATION_ADDRESS cannot be identical ("${hotWallet}")`
    );
  }

  // 4. Init Code Hash validation
  if (!config.CUSTODY_INIT_CODE_HASH || typeof config.CUSTODY_INIT_CODE_HASH !== 'string' || config.CUSTODY_INIT_CODE_HASH.trim() === '') {
    throw new Error('Production custody configuration error: CUSTODY_INIT_CODE_HASH is missing or empty');
  }

  const trimmedHash = config.CUSTODY_INIT_CODE_HASH.trim();
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmedHash)) {
    throw new Error(`Production custody configuration error: CUSTODY_INIT_CODE_HASH must be a 32-byte hex string (found "${trimmedHash}")`);
  }

  if (trimmedHash === ethers.ZeroHash || trimmedHash.toLowerCase() === '0x0000000000000000000000000000000000000000000000000000000000000000') {
    throw new Error('Production custody configuration error: CUSTODY_INIT_CODE_HASH cannot be zero hash');
  }

  const expectedInitCode = ethers.solidityPacked(
    ['bytes', 'bytes20', 'bytes'],
    [
      '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
      implementation,
      '0x5af43d82803e903d91602b57fd5bf3',
    ]
  );
  const expectedInitCodeHash = ethers.keccak256(expectedInitCode);

  if (trimmedHash.toLowerCase() !== expectedInitCodeHash.toLowerCase()) {
    throw new Error(
      `Production custody configuration error: CUSTODY_INIT_CODE_HASH mismatch. Derived hash from CUSTODY_IMPLEMENTATION_ADDRESS is ${expectedInitCodeHash} but configured hash is ${trimmedHash}`
    );
  }

  // 5. RPC endpoint safety (Reject localhost / loopback in production)
  const checkNoLocalhostRpc = (name: string, urlStr: string | undefined) => {
    if (!urlStr || typeof urlStr !== 'string' || urlStr.trim() === '') return;
    try {
      const parsed = new URL(urlStr.trim());
      const host = parsed.hostname.toLowerCase();
      if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host === '[::1]') {
        throw new Error(
          `Production custody configuration error: ${name} points to localhost ("${urlStr}") which is forbidden in production`
        );
      }
    } catch (err: any) {
      if (err.message.includes('Production custody configuration error')) throw err;
      throw new Error(`Production custody configuration error: ${name} is not a valid URL ("${urlStr}")`);
    }
  };

  checkNoLocalhostRpc('ETHEREUM_RPC_URL', config.ETHEREUM_RPC_URL);
  checkNoLocalhostRpc('CUSTODY_EVM_RPC_URL', config.CUSTODY_EVM_RPC_URL);
}

export function loadConfig(overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig {
  const nodeEnv = (overrides.NODE_ENV || process.env.NODE_ENV || 'development').toLowerCase();
  if (!['development', 'staging', 'production', 'test'].includes(nodeEnv)) {
    throw new Error(`Invalid NODE_ENV: "${nodeEnv}". Must be 'development', 'staging', 'production', or 'test'.`);
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

  const dbSslMode = (process.env.DB_SSL_MODE || 'auto').toLowerCase();
  if (!['auto', 'require', 'disable'].includes(dbSslMode)) {
    throw new Error(`Invalid DB_SSL_MODE: "${dbSslMode}". Must be 'auto', 'require', or 'disable'.`);
  }
  // TLS certificate validation defaults to ENABLED (secure). Operators of managed
  // providers with self-signed/intermediate certs may set *_SSL_REJECT_UNAUTHORIZED=false
  // as a conscious, documented choice, or supply *_CA_CERT for full verification.
  const dbSslRejectUnauthorized = parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED, true);
  const redisSslRejectUnauthorized = parseBoolean(process.env.REDIS_SSL_REJECT_UNAUTHORIZED, true);
  const autoMigrate = parseBoolean(process.env.AUTO_MIGRATE, nodeEnv === 'production');

  const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    throw new Error(`Invalid LOG_LEVEL: "${logLevel}". Must be 'debug', 'info', 'warn', or 'error'.`);
  }

  const dbHost = process.env.DB_HOST || 'localhost';
  const dbName = process.env.DB_NAME || 'mallick_exchange';
  const dbUser = process.env.DB_USER || 'mallick';
  const dbPassword = process.env.DB_PASSWORD || 'mallick_pass';
  if (nodeEnv === 'production' && !(overrides.DATABASE_URL || process.env.DATABASE_URL)) {
    throw new Error('DATABASE_URL must be provided in production');
  }
  const databaseUrl = overrides.DATABASE_URL || process.env.DATABASE_URL || `postgresql://${dbUser}:${dbPassword}@${dbHost}:${dbPort}/${dbName}`;

  const redisHost = process.env.REDIS_HOST || 'localhost';
  if (nodeEnv === 'production' && !(overrides.REDIS_URL || process.env.REDIS_URL)) {
    throw new Error('REDIS_URL must be provided in production');
  }
  const redisUrl = overrides.REDIS_URL || process.env.REDIS_URL || `redis://${redisHost}:${redisPort}`;

  const externalMarketDataEnabled = parseBoolean(process.env.EXTERNAL_MARKET_DATA_ENABLED, true);
  const externalMarketDataUrl = process.env.EXTERNAL_MARKET_DATA_URL || 'https://data-api.binance.vision/api/v3';
  const externalMarketDataFuturesUrl = process.env.EXTERNAL_MARKET_DATA_FUTURES_URL || 'https://fapi.binance.com/fapi/v1';
  const externalMarketDataPollIntervalMs = parseNumber(process.env.EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS, 3000, 'EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS');


  const hyperliquidEnvRaw = (overrides.HYPERLIQUID_ENV || process.env.HYPERLIQUID_ENV || '').toLowerCase();

  if (hyperliquidEnvRaw !== 'mainnet' && hyperliquidEnvRaw !== 'testnet') {
    throw new Error(`Invalid HYPERLIQUID_ENV: "${hyperliquidEnvRaw}". Must be exactly "mainnet" or "testnet".`);
  }

  if (nodeEnv === 'production' && hyperliquidEnvRaw !== 'mainnet') {
    // Policy: Testnet in production is FORBIDDEN unless explicitly bypassed. We enforce fail-closed here.
    throw new Error('HYPERLIQUID_ENV must be "mainnet" in production.');
  }

  if (nodeEnv !== 'production' && hyperliquidEnvRaw === 'mainnet') {
    throw new Error('HYPERLIQUID_ENV "mainnet" is strictly forbidden in non-production environments.');
  }

  let hyperliquidRestUrl = '';
  let hyperliquidWsUrl = '';
  let hyperliquidAgentPrivateKey = '';
  let hyperliquidAccountAddress = '';

  if (hyperliquidEnvRaw === 'testnet') {
    hyperliquidRestUrl = overrides.HYPERLIQUID_REST_URL || 'https://api.hyperliquid-testnet.xyz';
    hyperliquidWsUrl = overrides.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid-testnet.xyz/ws';
    hyperliquidAgentPrivateKey = overrides.HYPERLIQUID_AGENT_PRIVATE_KEY || process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY || '';
    hyperliquidAccountAddress = overrides.HYPERLIQUID_ACCOUNT_ADDRESS || process.env.HYPERLIQUID_TESTNET_ACCOUNT_ADDRESS || '';
    if (!hyperliquidAgentPrivateKey) {
       throw new Error('HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY is missing but HYPERLIQUID_ENV=testnet');
    }
  } else if (hyperliquidEnvRaw === 'mainnet') {
    hyperliquidRestUrl = overrides.HYPERLIQUID_REST_URL || 'https://api.hyperliquid.xyz';
    hyperliquidWsUrl = overrides.HYPERLIQUID_WS_URL || 'wss://api.hyperliquid.xyz/ws';
    hyperliquidAgentPrivateKey = overrides.HYPERLIQUID_AGENT_PRIVATE_KEY || process.env.HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY || '';
    hyperliquidAccountAddress = overrides.HYPERLIQUID_ACCOUNT_ADDRESS || process.env.HYPERLIQUID_MAINNET_ACCOUNT_ADDRESS || '';
    if (!hyperliquidAgentPrivateKey) {
       throw new Error('HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY is missing but HYPERLIQUID_ENV=mainnet');
    }
  }

  if ((!overrides.HYPERLIQUID_REST_URL && process.env.HYPERLIQUID_REST_URL) || (!overrides.HYPERLIQUID_WS_URL && process.env.HYPERLIQUID_WS_URL)) {
    throw new Error('Arbitrary HYPERLIQUID_REST_URL or HYPERLIQUID_WS_URL injection is forbidden. The endpoints are derived securely from HYPERLIQUID_ENV.');
  }

  const config: EnvironmentConfig = {
    NODE_ENV: nodeEnv as 'development' | 'staging' | 'production' | 'test',
    PORT: port,
    HOST: process.env.HOST || '0.0.0.0',
    API_PREFIX: process.env.API_PREFIX || '/api/v1',
    APP_NAME: process.env.APP_NAME || 'mallick-exchange-backend',

    HYPERLIQUID_ENV: hyperliquidEnvRaw as 'testnet' | 'mainnet',
    HYPERLIQUID_REST_URL: hyperliquidRestUrl,
    HYPERLIQUID_WS_URL: hyperliquidWsUrl,
    HYPERLIQUID_AGENT_PRIVATE_KEY: hyperliquidAgentPrivateKey,
    HYPERLIQUID_ACCOUNT_ADDRESS: hyperliquidAccountAddress,
    APP_VERSION: process.env.APP_VERSION || '1.0.0',
    CORS_ORIGIN: (nodeEnv === 'production' && (!(overrides.CORS_ORIGIN || process.env.CORS_ORIGIN) || (overrides.CORS_ORIGIN || process.env.CORS_ORIGIN)!.includes('*')))
    ? (() => { throw new Error('CORS_ORIGIN must be explicitly configured without wildcards in production'); })()
    : (overrides.CORS_ORIGIN || process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000'),
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
    DB_SSL_MODE: dbSslMode as 'auto' | 'require' | 'disable',
    DB_SSL_REJECT_UNAUTHORIZED: dbSslRejectUnauthorized,
    DB_CA_CERT: process.env.DB_CA_CERT || undefined,
    REDIS_URL: redisUrl,
    REDIS_HOST: redisHost,
    REDIS_PORT: redisPort,
    REDIS_PASSWORD: process.env.REDIS_PASSWORD || undefined,
    REDIS_CONNECT_TIMEOUT_MS: redisConnectTimeout,
    REDIS_RECONNECT_MAX_RETRIES: redisMaxRetries,
    REDIS_RECONNECT_BASE_DELAY_MS: redisBaseDelay,
    REDIS_RECONNECT_MAX_DELAY_MS: redisMaxDelay,
    REDIS_SSL_REJECT_UNAUTHORIZED: redisSslRejectUnauthorized,
    REDIS_CA_CERT: process.env.REDIS_CA_CERT || undefined,
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
    API_KEY_ENCRYPTION_SECRET: (nodeEnv === 'production' && !(overrides.API_KEY_ENCRYPTION_SECRET || process.env.API_KEY_ENCRYPTION_SECRET))
    ? (() => { throw new Error('API_KEY_ENCRYPTION_SECRET must be provided in production'); })()
    : (overrides.API_KEY_ENCRYPTION_SECRET || process.env.API_KEY_ENCRYPTION_SECRET || undefined),
    AUTO_MIGRATE: autoMigrate,
    EXTERNAL_MARKET_DATA_ENABLED: externalMarketDataEnabled,
    EXTERNAL_MARKET_DATA_URL: externalMarketDataUrl,
    EXTERNAL_MARKET_DATA_FUTURES_URL: externalMarketDataFuturesUrl,
    EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS: externalMarketDataPollIntervalMs,
    CUSTODY_ENABLED: parseBoolean(process.env.CUSTODY_ENABLED, false),
    CUSTODY_PROVIDER: process.env.CUSTODY_PROVIDER as 'mock' | 'local_kms' | 'kms' | 'manual_safe' | undefined,
    CUSTODY_KMS_KEY_ID: process.env.CUSTODY_KMS_KEY_ID,
    CUSTODY_EVM_RPC_URL: process.env.CUSTODY_EVM_RPC_URL,
    CUSTODY_KMS_REGION: process.env.CUSTODY_KMS_REGION,
    CUSTODY_FACTORY_ADDRESS: process.env.CUSTODY_FACTORY_ADDRESS,
    CUSTODY_IMPLEMENTATION_ADDRESS: process.env.CUSTODY_IMPLEMENTATION_ADDRESS,
    CUSTODY_INIT_CODE_HASH: process.env.CUSTODY_INIT_CODE_HASH,
    // Phase 11K — manual safe mode
    CUSTODY_HOT_WALLET_ADDRESS: process.env.CUSTODY_HOT_WALLET_ADDRESS || '',
    CUSTODY_CHAIN_ID: process.env.CUSTODY_CHAIN_ID
      ? parseNumber(process.env.CUSTODY_CHAIN_ID, 0, 'CUSTODY_CHAIN_ID')
      : (nodeEnv === 'production' ? 1 : 11155111),
    CRYPTO_WITHDRAWALS_ENABLED: parseBoolean(process.env.CRYPTO_WITHDRAWALS_ENABLED, false),
    // Phase 10.4 Step 6E-4C-2 sweep corrections:
    // Networks eligible for deposit sweeping (producer filter; CSV, uppercase).
    CUSTODY_SWEEPABLE_NETWORKS: process.env.CUSTODY_SWEEPABLE_NETWORKS || 'ETHEREUM',
    // Per-asset ERC20 dust policy in TOKEN BASE UNITS (CSV "ASSET=UNITS"),
    // e.g. "USDT=1000000,USDC=1000000". Empty = sweep everything. Documented
    // limitation: base units carry no market value — no oracle introduced.
    CUSTODY_SWEEP_MIN_TOKEN_UNITS: process.env.CUSTODY_SWEEP_MIN_TOKEN_UNITS || '',
    // Broadcast sweep artifacts unconfirmed longer than this are probed for
    // mempool/chain presence and escalated to STALE_BROADCAST when dropped.
    CUSTODY_SWEEP_STALE_BROADCAST_MINUTES: parseNumber(
      process.env.CUSTODY_SWEEP_STALE_BROADCAST_MINUTES,
      120,
      'CUSTODY_SWEEP_STALE_BROADCAST_MINUTES',
    ),
    // Stuck PROCESSING/SIGNING sweep recovery threshold (queue mechanics only —
    // durable sweep_intents preserve reserved nonces across recovery).
    CUSTODY_SWEEP_RECOVERY_TIMEOUT_MINUTES: parseNumber(
      process.env.CUSTODY_SWEEP_RECOVERY_TIMEOUT_MINUTES,
      5,
      'CUSTODY_SWEEP_RECOVERY_TIMEOUT_MINUTES',
    ),
    BLOCKCHAIN_MONITORING_ENABLED: parseBoolean(process.env.BLOCKCHAIN_MONITORING_ENABLED, false),
    DEPOSIT_CREDITING_ENABLED: parseBoolean(process.env.DEPOSIT_CREDITING_ENABLED, false),
    ETHEREUM_RPC_URL: process.env.ETHEREUM_RPC_URL || '',
    BITCOIN_API_URL: process.env.BITCOIN_API_URL || '',
    BLOCKCHAIN_MONITOR_POLL_INTERVAL_MS: parseNumber(
      process.env.BLOCKCHAIN_MONITOR_POLL_INTERVAL_MS,
      30000,
      'BLOCKCHAIN_MONITOR_POLL_INTERVAL_MS',
    ),
    BLOCKCHAIN_CONFIRMATION_POLL_INTERVAL_MS: parseNumber(
      process.env.BLOCKCHAIN_CONFIRMATION_POLL_INTERVAL_MS,
      60000,
      'BLOCKCHAIN_CONFIRMATION_POLL_INTERVAL_MS',
    ),
    WITHDRAWAL_REVIEW_THRESHOLD: process.env.WITHDRAWAL_REVIEW_THRESHOLD,
    NOTIFICATION_PROVIDER: process.env.NOTIFICATION_PROVIDER,
    SENDGRID_API_KEY: process.env.SENDGRID_API_KEY,
    NOTIFICATION_FROM_EMAIL: process.env.NOTIFICATION_FROM_EMAIL,
    NOTIFICATION_FROM_NAME: process.env.NOTIFICATION_FROM_NAME,
    ...overrides
  };

  if (config.NODE_ENV === 'production') {
    validateProductionCustodyConfig(config);
  }

  return config;
}

export const env = loadConfig();

