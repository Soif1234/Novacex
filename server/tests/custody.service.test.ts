import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createCustodyService } from '../src/services/custody/custody.service';
import { env } from '../src/config/env';
import { KmsCustodyProvider } from '../src/services/custody/kms-custody-provider';
import { MockCustodyProvider } from '../src/services/custody/mock-custody-provider';

// Mock DB and environment
vi.mock('../src/config/env', () => ({
  env: {
    CUSTODY_ENABLED: true,
    CUSTODY_PROVIDER: '',
    CUSTODY_EVM_RPC_URL: '',
    CUSTODY_KMS_KEY_ID: '',
    NODE_ENV: 'test'
  }
}));

vi.mock('../src/config/database', () => ({
  db: {}
}));

describe('CustodyService Configuration', () => {
  beforeEach(() => {
    env.CUSTODY_ENABLED = true;
    env.NODE_ENV = 'test';
    env.CUSTODY_PROVIDER = undefined as any;
    env.CUSTODY_EVM_RPC_URL = undefined as any;
    env.CUSTODY_KMS_KEY_ID = undefined as any;
  });

  it('A. CUSTODY_PROVIDER=mock -> MockCustodyProvider', () => {
    env.CUSTODY_PROVIDER = 'mock';
    const s = createCustodyService();
    expect((s as any).adapter).toBeInstanceOf(MockCustodyProvider);
  });

  it('B. CUSTODY_PROVIDER=kms -> KmsCustodyProvider (local)', () => {
    env.CUSTODY_PROVIDER = 'kms';
    env.CUSTODY_EVM_RPC_URL = 'http://127.0.0.1:8545';
    env.CUSTODY_KMS_KEY_ID = 'test-key';
    const s = createCustodyService();
    expect((s as any).adapter).toBeInstanceOf(KmsCustodyProvider);
  });

  it('C. unknown provider -> FAIL', () => {
    env.CUSTODY_PROVIDER = 'garbage' as any;
    expect(() => createCustodyService()).toThrow('Unknown CUSTODY_PROVIDER');
  });

  it('D. production + missing provider -> FAIL', () => {
    env.NODE_ENV = 'production';
    env.CUSTODY_PROVIDER = undefined as any;
    expect(() => createCustodyService()).toThrow('explicitly configured in production');
  });

  it('E. production + mock -> FAIL', () => {
    env.NODE_ENV = 'production';
    env.CUSTODY_PROVIDER = 'mock';
    expect(() => createCustodyService()).toThrow('forbidden in production');
  });

  it('F. production + localhost RPC -> FAIL', () => {
    env.NODE_ENV = 'production';
    env.CUSTODY_PROVIDER = 'kms';
    env.CUSTODY_KMS_KEY_ID = 'valid-key';
    env.CUSTODY_EVM_RPC_URL = 'http://127.0.0.1:8545';
    expect(() => createCustodyService()).toThrow('Localhost RPC is forbidden');
  });

  it('G. production + missing RPC -> FAIL', () => {
    env.NODE_ENV = 'production';
    env.CUSTODY_PROVIDER = 'kms';
    env.CUSTODY_KMS_KEY_ID = 'valid-key';
    expect(() => createCustodyService()).toThrow('CUSTODY_EVM_RPC_URL is required');
  });

  it('H. KMS mode missing KMS key -> FAIL', () => {
    env.CUSTODY_PROVIDER = 'kms';
    env.CUSTODY_EVM_RPC_URL = 'http://10.0.0.1:8545';
    expect(() => createCustodyService()).toThrow('CUSTODY_KMS_KEY_ID is required');
  });

  it('I. mock mode -> no AWS initialization', () => {
    env.CUSTODY_PROVIDER = 'mock';
    const s = createCustodyService();
    expect((s as any).adapter).toBeInstanceOf(MockCustodyProvider);
  });
});
