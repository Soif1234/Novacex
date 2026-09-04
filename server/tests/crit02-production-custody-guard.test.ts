import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ethers } from 'ethers';
import {
  loadConfig,
  validateProductionCustodyConfig,
  EnvironmentConfig,
  SEPOLIA_TEST_ADDRESSES,
  KNOWN_TEST_FIXTURES,
} from '../src/config/env';

describe('Phase 15D-2 — CRIT-02: Production Mainnet Custody Configuration Guard', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // Base production addresses (valid mainnet, non-fixture, non-Sepolia, isolated)
  const VALID_MAINNET_IMPL = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D';
  const VALID_MAINNET_FACTORY = '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45';
  const VALID_MAINNET_HOT_WALLET = '0x2B5AD5c4795c026514f8317c7a215E218DcCD6cF';

  const computeInitCodeHash = (impl: string) => {
    const code = ethers.solidityPacked(
      ['bytes', 'bytes20', 'bytes'],
      [
        '0x3d602d80600a3d3981f3363d3d373d3d3d363d73',
        ethers.getAddress(impl),
        '0x5af43d82803e903d91602b57fd5bf3',
      ]
    );
    return ethers.keccak256(code);
  };

  const VALID_INIT_CODE_HASH = computeInitCodeHash(VALID_MAINNET_IMPL);

  const createBaseProductionConfig = (overrides: Partial<EnvironmentConfig> = {}): EnvironmentConfig => {
    return {
      NODE_ENV: 'production',
      PORT: 4000,
      HOST: '0.0.0.0',
      API_PREFIX: '/api/v1',
      APP_NAME: 'mallick-exchange-backend',
      APP_VERSION: '1.0.0',
      CORS_ORIGIN: 'https://novacex.io',
      DATABASE_URL: 'postgresql://prod_user:secret@db.novacex.io:5432/novacex',
      DB_HOST: 'db.novacex.io',
      DB_PORT: 5432,
      DB_NAME: 'novacex',
      DB_USER: 'prod_user',
      DB_PASSWORD: 'secret',
      DB_POOL_MIN: 2,
      DB_POOL_MAX: 20,
      DB_CONNECTION_TIMEOUT_MS: 5000,
      DB_IDLE_TIMEOUT_MS: 30000,
      DB_QUERY_TIMEOUT_MS: 10000,
      DB_SSL_MODE: 'require',
      DB_SSL_REJECT_UNAUTHORIZED: true,
      REDIS_URL: 'redis://redis.novacex.io:6379',
      REDIS_HOST: 'redis.novacex.io',
      REDIS_PORT: 6379,
      REDIS_CONNECT_TIMEOUT_MS: 3000,
      REDIS_RECONNECT_MAX_RETRIES: 10,
      REDIS_RECONNECT_BASE_DELAY_MS: 500,
      REDIS_RECONNECT_MAX_DELAY_MS: 10000,
      REDIS_SSL_REJECT_UNAUTHORIZED: true,
      RATE_LIMIT_ENABLED: true,
      RATE_LIMIT_GLOBAL_MAX: 300,
      RATE_LIMIT_AUTH_MAX: 20,
      RATE_LIMIT_MUTATION_MAX: 60,
      RATE_LIMIT_API_KEY_MAX: 120,
      RATE_LIMIT_WINDOW_MS: 60000,
      LOAD_SHEDDING_ENABLED: true,
      LOAD_SHEDDING_MAX_CONCURRENT_REQUESTS: 100,
      LOAD_SHEDDING_DB_WAITING_THRESHOLD: 15,
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10000,
      API_KEY_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef',
      AUTO_MIGRATE: false,
      EXTERNAL_MARKET_DATA_ENABLED: true,
      EXTERNAL_MARKET_DATA_URL: 'https://data-api.binance.vision/api/v3',
      EXTERNAL_MARKET_DATA_FUTURES_URL: 'https://fapi.binance.com/fapi/v1',
      EXTERNAL_MARKET_DATA_POLL_INTERVAL_MS: 3000,
      HYPERLIQUID_ENV: 'mainnet',
      HYPERLIQUID_REST_URL: 'https://api.hyperliquid.xyz',
      HYPERLIQUID_WS_URL: 'wss://api.hyperliquid.xyz/ws',
      HYPERLIQUID_AGENT_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      HYPERLIQUID_ACCOUNT_ADDRESS: '0x1234567890123456789012345678901234567890',
      CUSTODY_ENABLED: true,
      CUSTODY_PROVIDER: 'manual_safe',
      CUSTODY_CHAIN_ID: 1,
      CUSTODY_HOT_WALLET_ADDRESS: VALID_MAINNET_HOT_WALLET,
      CUSTODY_FACTORY_ADDRESS: VALID_MAINNET_FACTORY,
      CUSTODY_IMPLEMENTATION_ADDRESS: VALID_MAINNET_IMPL,
      CUSTODY_INIT_CODE_HASH: VALID_INIT_CODE_HASH,
      CRYPTO_WITHDRAWALS_ENABLED: true,
      CUSTODY_SWEEPABLE_NETWORKS: 'ETHEREUM',
      CUSTODY_SWEEP_MIN_TOKEN_UNITS: '',
      CUSTODY_SWEEP_STALE_BROADCAST_MINUTES: 120,
      CUSTODY_SWEEP_RECOVERY_TIMEOUT_MINUTES: 5,
      BLOCKCHAIN_MONITORING_ENABLED: true,
      DEPOSIT_CREDITING_ENABLED: true,
      ETHEREUM_RPC_URL: 'https://eth-mainnet.g.alchemy.com/v2/actual_key',
      BITCOIN_API_URL: '',
      BLOCKCHAIN_MONITOR_POLL_INTERVAL_MS: 30000,
      BLOCKCHAIN_CONFIRMATION_POLL_INTERVAL_MS: 60000,
      ...overrides,
    };
  };

  // -------------------------------------------------------------------------
  // Scenario A: Valid Production Configuration Accepted
  // -------------------------------------------------------------------------
  it('A. production + chain 1 + valid non-testnet addresses + valid initCodeHash -> accepted', () => {
    const config = createBaseProductionConfig();
    expect(() => validateProductionCustodyConfig(config)).not.toThrow();
  });

  // -------------------------------------------------------------------------
  // Scenario B: Chain ID Mismatch Rejected
  // -------------------------------------------------------------------------
  it('B. production + chain 11155111 (Sepolia) -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_CHAIN_ID: 11155111 });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_CHAIN_ID must be 1 \(Ethereum Mainnet\) in production/
    );
  });

  it('B2. production + chain 0 -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_CHAIN_ID: 0 });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_CHAIN_ID must be 1 \(Ethereum Mainnet\) in production/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario C: Missing Factory Address Rejected
  // -------------------------------------------------------------------------
  it('C. production + missing Factory -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_FACTORY_ADDRESS: undefined });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_FACTORY_ADDRESS is missing or empty/
    );
  });

  it('C2. production + empty Factory string -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_FACTORY_ADDRESS: '   ' });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_FACTORY_ADDRESS is missing or empty/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario D: Missing Implementation Address Rejected
  // -------------------------------------------------------------------------
  it('D. production + missing Implementation -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_IMPLEMENTATION_ADDRESS: undefined });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_IMPLEMENTATION_ADDRESS is missing or empty/
    );
  });

  it('D2. production + empty Implementation string -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_IMPLEMENTATION_ADDRESS: '' });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_IMPLEMENTATION_ADDRESS is missing or empty/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario E: Missing Hot Wallet Address Rejected
  // -------------------------------------------------------------------------
  it('E. production + missing Hot Wallet -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_HOT_WALLET_ADDRESS: undefined });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS is missing or empty/
    );
  });

  it('E2. production + empty Hot Wallet string -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_HOT_WALLET_ADDRESS: '' });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS is missing or empty/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario F: Zero Address Rejected
  // -------------------------------------------------------------------------
  it('F1. production + zero address Factory -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_FACTORY_ADDRESS: ethers.ZeroAddress,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_FACTORY_ADDRESS cannot be the zero address/
    );
  });

  it('F2. production + zero address Implementation -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_IMPLEMENTATION_ADDRESS: '0x0000000000000000000000000000000000000000',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_IMPLEMENTATION_ADDRESS cannot be the zero address/
    );
  });

  it('F3. production + zero address Hot Wallet -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: ethers.ZeroAddress,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS cannot be the zero address/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario G: Malformed Address Rejected
  // -------------------------------------------------------------------------
  it('G1. production + malformed Factory (short length) -> rejected', () => {
    const config = createBaseProductionConfig({ CUSTODY_FACTORY_ADDRESS: '0x1234' });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_FACTORY_ADDRESS is not a valid EVM address/
    );
  });

  it('G2. production + malformed Implementation (invalid hex chars) -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_IMPLEMENTATION_ADDRESS: '0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_IMPLEMENTATION_ADDRESS is not a valid EVM address/
    );
  });

  it('G3. production + placeholder string -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: '0xTODO_REPLACE_WITH_REAL_WALLET',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS is a placeholder/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario H: Known Sepolia Factory Address Rejected
  // -------------------------------------------------------------------------
  it('H. production + known Sepolia Factory (0x31c5a0946fde4dD32C9da92f8c035b4A17fC1737) -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_FACTORY_ADDRESS: '0x31c5a0946fde4dD32C9da92f8c035b4A17fC1737',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_FACTORY_ADDRESS matches known Sepolia test address/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario I: Known Sepolia Forwarder Implementation Rejected
  // -------------------------------------------------------------------------
  it('I. production + known Sepolia Forwarder (0xCd7CAEF9a5237A82E48Ce1790AfFB57878847fd9) -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_IMPLEMENTATION_ADDRESS: '0xCd7CAEF9a5237A82E48Ce1790AfFB57878847fd9',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_IMPLEMENTATION_ADDRESS matches known Sepolia test address/
    );
  });

  // -------------------------------------------------------------------------
  // Scenario J: Known Sepolia Hot Wallet Rejected
  // -------------------------------------------------------------------------
  it('J. production + known Sepolia Hot Wallet (0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95) -> rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS matches known Sepolia test address/
    );
  });

  // -------------------------------------------------------------------------
  // Scenarios K & L: Staging and Development Environments Allow Sepolia Values
  // -------------------------------------------------------------------------
  it('K. staging + Sepolia values -> remains allowed without production custody guard error', () => {
    const stagingConfig = loadConfig({
      NODE_ENV: 'staging',
      CUSTODY_CHAIN_ID: 11155111,
      CUSTODY_HOT_WALLET_ADDRESS: '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95',
      CUSTODY_FACTORY_ADDRESS: '0x31c5a0946fde4dD32C9da92f8c035b4A17fC1737',
      CUSTODY_IMPLEMENTATION_ADDRESS: '0xCd7CAEF9a5237A82E48Ce1790AfFB57878847fd9',
    });
    expect(stagingConfig.NODE_ENV).toBe('staging');
    expect(stagingConfig.CUSTODY_CHAIN_ID).toBe(11155111);
    expect(stagingConfig.CUSTODY_HOT_WALLET_ADDRESS).toBe('0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95');
  });

  it('L. development + Sepolia values -> remains allowed without production custody guard error', () => {
    const devConfig = loadConfig({
      NODE_ENV: 'development',
      CUSTODY_CHAIN_ID: 11155111,
      CUSTODY_HOT_WALLET_ADDRESS: '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95',
      CUSTODY_FACTORY_ADDRESS: '0x31c5a0946fde4dD32C9da92f8c035b4A17fC1737',
      CUSTODY_IMPLEMENTATION_ADDRESS: '0xCd7CAEF9a5237A82E48Ce1790AfFB57878847fd9',
    });
    expect(devConfig.NODE_ENV).toBe('development');
    expect(devConfig.CUSTODY_CHAIN_ID).toBe(11155111);
  });

  // -------------------------------------------------------------------------
  // Scenario M: Production Fail-Closed Startup Guard
  // -------------------------------------------------------------------------
  it('M. manual_safe + production + invalid custody configuration -> loadConfig fails closed on process startup', () => {
    expect(() =>
      loadConfig({
        NODE_ENV: 'production',
        CUSTODY_PROVIDER: 'manual_safe',
        CUSTODY_CHAIN_ID: 11155111, // Bad chain in production!
        DATABASE_URL: 'postgresql://prod:secret@db.novacex.io:5432/novacex',
        REDIS_URL: 'redis://redis.novacex.io:6379',
        CORS_ORIGIN: 'https://novacex.io',
        API_KEY_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef',
        HYPERLIQUID_ENV: 'mainnet',
        HYPERLIQUID_AGENT_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
        HYPERLIQUID_ACCOUNT_ADDRESS: '0x1234567890123456789012345678901234567890',
        CUSTODY_HOT_WALLET_ADDRESS: VALID_MAINNET_HOT_WALLET,
        CUSTODY_FACTORY_ADDRESS: VALID_MAINNET_FACTORY,
        CUSTODY_IMPLEMENTATION_ADDRESS: VALID_MAINNET_IMPL,
        CUSTODY_INIT_CODE_HASH: VALID_INIT_CODE_HASH,
      })
    ).toThrow(/CUSTODY_CHAIN_ID must be 1 \(Ethereum Mainnet\) in production/);
  });

  // -------------------------------------------------------------------------
  // Scenario N: Valid Production Config Requires NO Server-Held Private Keys or KMS
  // -------------------------------------------------------------------------
  it('N. Valid production configuration does NOT require private keys or KMS', () => {
    const prodConfig = loadConfig({
      NODE_ENV: 'production',
      CUSTODY_PROVIDER: 'manual_safe',
      CUSTODY_CHAIN_ID: 1,
      DATABASE_URL: 'postgresql://prod:secret@db.novacex.io:5432/novacex',
      REDIS_URL: 'redis://redis.novacex.io:6379',
      CORS_ORIGIN: 'https://novacex.io',
      API_KEY_ENCRYPTION_SECRET: '0123456789abcdef0123456789abcdef',
      HYPERLIQUID_ENV: 'mainnet',
      HYPERLIQUID_AGENT_PRIVATE_KEY: '0x1234567890123456789012345678901234567890123456789012345678901234',
      HYPERLIQUID_ACCOUNT_ADDRESS: '0x1234567890123456789012345678901234567890',
      CUSTODY_HOT_WALLET_ADDRESS: VALID_MAINNET_HOT_WALLET,
      CUSTODY_FACTORY_ADDRESS: VALID_MAINNET_FACTORY,
      CUSTODY_IMPLEMENTATION_ADDRESS: VALID_MAINNET_IMPL,
      CUSTODY_INIT_CODE_HASH: VALID_INIT_CODE_HASH,
      CUSTODY_KMS_KEY_ID: undefined,
      CUSTODY_KMS_REGION: undefined,
    });

    expect(prodConfig.CUSTODY_PROVIDER).toBe('manual_safe');
    expect(prodConfig.CUSTODY_KMS_KEY_ID).toBeUndefined();
    expect(prodConfig.CUSTODY_KMS_REGION).toBeUndefined();
    expect((prodConfig as any).HOT_WALLET_PRIVATE_KEY).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Scenario O: Edge Cases & Additional Invariant Guards
  // -------------------------------------------------------------------------
  it('O1. Repeated dummy hex address is rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: '0x1111111111111111111111111111111111111111',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS is a repeated-byte test fixture/
    );
  });

  it('O2. Known Hardhat test fixture is rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', // Hardhat #0
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS matches known test fixture address/
    );
  });

  it('O3. Relational isolation: Factory cannot equal Implementation', () => {
    const config = createBaseProductionConfig({
      CUSTODY_FACTORY_ADDRESS: VALID_MAINNET_IMPL,
      CUSTODY_IMPLEMENTATION_ADDRESS: VALID_MAINNET_IMPL,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_FACTORY_ADDRESS and CUSTODY_IMPLEMENTATION_ADDRESS cannot be identical/
    );
  });

  it('O4. Relational isolation: Hot Wallet cannot equal Factory', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: VALID_MAINNET_FACTORY,
      CUSTODY_FACTORY_ADDRESS: VALID_MAINNET_FACTORY,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS and CUSTODY_FACTORY_ADDRESS cannot be identical/
    );
  });

  it('O5. Relational isolation: Hot Wallet cannot equal Implementation', () => {
    const config = createBaseProductionConfig({
      CUSTODY_HOT_WALLET_ADDRESS: VALID_MAINNET_IMPL,
      CUSTODY_IMPLEMENTATION_ADDRESS: VALID_MAINNET_IMPL,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_HOT_WALLET_ADDRESS and CUSTODY_IMPLEMENTATION_ADDRESS cannot be identical/
    );
  });

  it('O6. Init code hash mismatch is rejected', () => {
    const badHash = '0x1122334455667788990011223344556677889900112233445566778899001122';
    const config = createBaseProductionConfig({
      CUSTODY_INIT_CODE_HASH: badHash,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_INIT_CODE_HASH mismatch/
    );
  });

  it('O7. Zero init code hash is rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_INIT_CODE_HASH: ethers.ZeroHash,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_INIT_CODE_HASH cannot be zero hash/
    );
  });

  it('O8. Missing init code hash in production is rejected', () => {
    const config = createBaseProductionConfig({
      CUSTODY_INIT_CODE_HASH: '',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_INIT_CODE_HASH is missing or empty/
    );
  });

  it('O9. Provider must be manual_safe in production (kms rejected)', () => {
    const config = createBaseProductionConfig({
      CUSTODY_PROVIDER: 'kms' as any,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_PROVIDER must be 'manual_safe' in production/
    );
  });

  it('O10. Provider must be manual_safe in production (mock rejected)', () => {
    const config = createBaseProductionConfig({
      CUSTODY_PROVIDER: 'mock' as any,
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_PROVIDER must be 'manual_safe' in production/
    );
  });

  it('O11. Localhost RPC is forbidden in production for ETHEREUM_RPC_URL', () => {
    const config = createBaseProductionConfig({
      ETHEREUM_RPC_URL: 'http://127.0.0.1:8545',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /ETHEREUM_RPC_URL points to localhost.*forbidden in production/
    );
  });

  it('O12. Localhost RPC is forbidden in production for CUSTODY_EVM_RPC_URL', () => {
    const config = createBaseProductionConfig({
      CUSTODY_EVM_RPC_URL: 'http://localhost:8545',
    });
    expect(() => validateProductionCustodyConfig(config)).toThrow(
      /CUSTODY_EVM_RPC_URL points to localhost.*forbidden in production/
    );
  });
});
