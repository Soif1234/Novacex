import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { HyperliquidClient } from '../src/services/liquidity/hyperliquid/hyperliquid.client';
import { HyperliquidWebSocketClient } from '../src/services/liquidity/hyperliquid/hyperliquid.ws';

describe('Hyperliquid Environment Isolation & Resolution', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    delete process.env.HYPERLIQUID_ENV;
    delete process.env.HYPERLIQUID_REST_URL;
    delete process.env.HYPERLIQUID_WS_URL;
    delete process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY;
    delete process.env.HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY;
    delete process.env.NODE_ENV;
    process.env.DB_PASSWORD = 'test';
    process.env.DATABASE_URL = 'postgres://test';
    process.env.REDIS_URL = 'redis://test';
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  async function loadConfig() {
    // Dynamic import to force re-evaluation of env.ts on each test
    const mod = await import('../src/config/env.ts?t=' + Date.now());
    return mod.env;
  }

  it('A. missing HYPERLIQUID_ENV fails closed', async () => {
    await expect(loadConfig()).rejects.toThrow(/Invalid HYPERLIQUID_ENV/);
  });

  it('B. invalid HYPERLIQUID_ENV fails closed', async () => {
    process.env.HYPERLIQUID_ENV = 'dev';
    await expect(loadConfig()).rejects.toThrow(/Invalid HYPERLIQUID_ENV/);
  });

  it('C. testnet + missing testnet credential fails closed', async () => {
    process.env.HYPERLIQUID_ENV = 'testnet';
    await expect(loadConfig()).rejects.toThrow(/HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY is missing/);
  });

  it('D. mainnet + missing mainnet credential fails closed', async () => {
    process.env.HYPERLIQUID_ENV = 'mainnet';
    await expect(loadConfig()).rejects.toThrow(/HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY is missing/);
  });

  it('E. testnet + attempted mainnet endpoint injection fails closed', async () => {
    process.env.HYPERLIQUID_ENV = 'testnet';
    process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY = 'test_key';
    process.env.HYPERLIQUID_REST_URL = 'https://api.hyperliquid.xyz';
    await expect(loadConfig()).rejects.toThrow(/Arbitrary HYPERLIQUID_REST_URL or HYPERLIQUID_WS_URL injection is forbidden/);
  });

  it('F. mainnet + attempted testnet endpoint injection fails closed', async () => {
    process.env.HYPERLIQUID_ENV = 'mainnet';
    process.env.HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY = 'main_key';
    process.env.HYPERLIQUID_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';
    await expect(loadConfig()).rejects.toThrow(/Arbitrary HYPERLIQUID_REST_URL or HYPERLIQUID_WS_URL injection is forbidden/);
  });

  it('G. mixed REST/WS environment injection fails closed', async () => {
    process.env.HYPERLIQUID_ENV = 'testnet';
    process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY = 'test_key';
    process.env.HYPERLIQUID_REST_URL = 'https://api.hyperliquid.xyz';
    process.env.HYPERLIQUID_WS_URL = 'wss://api.hyperliquid-testnet.xyz/ws';
    await expect(loadConfig()).rejects.toThrow(/Arbitrary HYPERLIQUID_REST_URL/);
  });

  it('H. testnet + only mainnet credential present fails closed without fallback', async () => {
    process.env.HYPERLIQUID_ENV = 'testnet';
    process.env.HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY = 'main_key';
    await expect(loadConfig()).rejects.toThrow(/HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY is missing/);
  });

  it('I. mainnet + only testnet credential present fails closed without fallback', async () => {
    process.env.HYPERLIQUID_ENV = 'mainnet';
    process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY = 'test_key';
    await expect(loadConfig()).rejects.toThrow(/HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY is missing/);
  });

  it('J. production + missing explicit environment fails closed', async () => {
    process.env.NODE_ENV = 'production';
    await expect(loadConfig()).rejects.toThrow(/Invalid HYPERLIQUID_ENV/);
  });

  it('K. production + testnet environment is prohibited by default', async () => {
    process.env.NODE_ENV = 'production';
    process.env.HYPERLIQUID_ENV = 'testnet';
    process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY = 'test_key';
    await expect(loadConfig()).rejects.toThrow(/HYPERLIQUID_ENV must be "mainnet" in production/);
  });

  it('L. valid testnet resolves correct endpoints and credentials', async () => {
    process.env.HYPERLIQUID_ENV = 'testnet';
    process.env.HYPERLIQUID_TESTNET_AGENT_PRIVATE_KEY = 'test_key';
    const cfg = await loadConfig();
    expect(cfg.HYPERLIQUID_ENV).toBe('testnet');
    expect(cfg.HYPERLIQUID_REST_URL).toBe('https://api.hyperliquid-testnet.xyz');
    expect(cfg.HYPERLIQUID_WS_URL).toBe('wss://api.hyperliquid-testnet.xyz/ws');
    expect(cfg.HYPERLIQUID_AGENT_PRIVATE_KEY).toBe('test_key');
  });

  it('M. valid mainnet resolves correct endpoints and credentials', async () => {
    process.env.HYPERLIQUID_ENV = 'mainnet';
    process.env.HYPERLIQUID_MAINNET_AGENT_PRIVATE_KEY = 'main_key';
    const cfg = await loadConfig();
    expect(cfg.HYPERLIQUID_ENV).toBe('mainnet');
    expect(cfg.HYPERLIQUID_REST_URL).toBe('https://api.hyperliquid.xyz');
    expect(cfg.HYPERLIQUID_WS_URL).toBe('wss://api.hyperliquid.xyz/ws');
    expect(cfg.HYPERLIQUID_AGENT_PRIVATE_KEY).toBe('main_key');
  });
});


describe('Hyperliquid Client Constructor Environment Propagation', () => {
  it('N. testnet environment -> client resolves testnet REST endpoint and signer', () => {
    const client = new HyperliquidClient({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
      accountAddress: '0xabc'
    });
    expect((client as any).baseUrl).toBe('https://api.hyperliquid-testnet.xyz');
    expect((client as any).isMainnet).toBe(false);
    expect((client as any).signer.isMainnet).toBe(false);
  });

  it('O. mainnet environment -> client resolves mainnet REST endpoint and signer', () => {
    const client = new HyperliquidClient({
      hyperliquidEnv: 'mainnet',
      agentPrivateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
      accountAddress: '0xabc'
    });
    expect((client as any).baseUrl).toBe('https://api.hyperliquid.xyz');
    expect((client as any).isMainnet).toBe(true);
    expect((client as any).signer.isMainnet).toBe(true);
  });

  it('P. legacy baseUrl injection is safely ignored by client', () => {
    const client = new HyperliquidClient({
      hyperliquidEnv: 'testnet',
      agentPrivateKey: '0x1234567890123456789012345678901234567890123456789012345678901234',
      accountAddress: '0xabc',
      baseUrl: 'https://malicious.com',
      isMainnet: true
    } as any);

    expect((client as any).baseUrl).toBe('https://api.hyperliquid-testnet.xyz');
    expect((client as any).isMainnet).toBe(false);
  });
});
