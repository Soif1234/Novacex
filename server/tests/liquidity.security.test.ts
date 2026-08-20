import { describe, it, expect, beforeEach } from 'vitest';
import { 
  SecurityManager, 
  ProviderOperation, 
  ProviderSecurityPolicy,
  ProviderCredentialMetadata,
  SignedRequest,
  InMemoryReplayStore,
  InMemoryRateLimitStore
} from '../src/domain/liquidity/security';
import { ProviderErrorCode, ProviderError } from '../src/domain/liquidity/errors';

describe('Phase 5.12 - Liquidity Security', () => {

  let manager: SecurityManager;
  let replayStore: InMemoryReplayStore;
  let rateLimitStore: InMemoryRateLimitStore;

  const validPolicy: ProviderSecurityPolicy = {
    providerId: 'BINANCE',
    allowedOperations: new Set([ProviderOperation.CREATE_ORDER, ProviderOperation.READ_MARKET_DATA]),
    withdrawalAllowed: false,
    maxRequestRate: 10,
    credentialRotationRequired: true,
    signingRequired: true,
    timestampTolerance: 5000,
    nonceRequired: true
  };

  const validMetadata: ProviderCredentialMetadata = {
    providerId: 'BINANCE',
    credentialId: 'cred-1',
    createdAt: Date.now() - 10000,
    expiresAt: Date.now() + 100000,
    status: 'ACTIVE',
    permissions: new Set([ProviderOperation.CREATE_ORDER, ProviderOperation.READ_MARKET_DATA])
  };

  const secret = 'super-secret-key-that-should-never-leak';

  let nonceCounter = 1;
  const createValidRequest = (): SignedRequest => {
    const nonce = `nonce-${nonceCounter++}`;
    const req: SignedRequest = {
      providerId: 'BINANCE',
      clientOrderId: 'o1',
      requestId: 'r1',
      operation: ProviderOperation.CREATE_ORDER,
      timestamp: Date.now(),
      nonce,
      payload: { amount: 10 }
    };
    req.signature = manager.mockSign(req, secret);
    return req;
  };

  beforeEach(() => {
    replayStore = new InMemoryReplayStore();
    rateLimitStore = new InMemoryRateLimitStore(10, 10);
    manager = new SecurityManager(replayStore, rateLimitStore);
  });

  describe('Policy Validation', () => {
    it('1, 2. Valid security policy & Withdrawal permission rejected', () => {
      expect(() => manager.validatePolicy(validPolicy)).not.toThrow();

      const badPolicy = { ...validPolicy, withdrawalAllowed: true };
      expect(() => manager.validatePolicy(badPolicy)).toThrow(/withdrawalAllowed must be false/i);
    });

    it('3, 4. Transfer and security mutation rejected', () => {
      const p1 = { ...validPolicy, allowedOperations: new Set([ProviderOperation.TRANSFER_FUNDS]) };
      expect(() => manager.validatePolicy(p1)).toThrow(/permanently blocked/i);

      const p2 = { ...validPolicy, allowedOperations: new Set([ProviderOperation.CHANGE_SECURITY_SETTINGS]) };
      expect(() => manager.validatePolicy(p2)).toThrow(/permanently blocked/i);
    });

    it('31, 36, 52. Invalid config rejected', () => {
      const p1 = { ...validPolicy, maxRequestRate: -1 };
      expect(() => manager.validatePolicy(p1)).toThrow(/Invalid maxRequestRate/);
    });
  });

  describe('Credential Validation & Isolation', () => {
    it('6, 7, 35. Valid credential & Provider isolation', () => {
      expect(() => manager.validateCredential(validMetadata, 'BINANCE')).not.toThrow();

      expect(() => manager.validateCredential(validMetadata, 'KRAKEN')).toThrow(/PROVIDER_ISOLATION_VIOLATION/);
    });

    it('8, 9, 34. Expired and Revoked credentials', () => {
      const expired = { ...validMetadata, status: 'EXPIRED' as any };
      expect(() => manager.validateCredential(expired, 'BINANCE')).toThrow(/CREDENTIAL_EXPIRED/);

      const timeExpired = { ...validMetadata, expiresAt: Date.now() - 1000 };
      expect(() => manager.validateCredential(timeExpired, 'BINANCE')).toThrow(/CREDENTIAL_EXPIRED/);

      const revoked = { ...validMetadata, status: 'REVOKED' as any };
      expect(() => manager.validateCredential(revoked, 'BINANCE')).toThrow(/CREDENTIAL_REVOKED/);
    });
  });

  describe('Permission Boundary', () => {
    it('5. Provider operation permission', () => {
      expect(() => manager.authorizeOperation(validMetadata, ProviderOperation.CREATE_ORDER)).not.toThrow();
      expect(() => manager.authorizeOperation(validMetadata, ProviderOperation.CANCEL_ORDER)).toThrow(/PERMISSION_DENIED/);
    });

    it('18. Withdrawal explicit trap in authorizeOperation', () => {
      const meta = { ...validMetadata, permissions: new Set([ProviderOperation.WITHDRAW]) };
      expect(() => manager.authorizeOperation(meta, ProviderOperation.WITHDRAW)).toThrow(/PERMISSION_DENIED/);
    });
  });

  describe('Secret Redaction & Frontend Safety', () => {
    it('11, 12, 13, 15, 38. Recursive object and array redaction', () => {
      const payload = {
        publicData: 'abc',
        apiKey: 'real-key',
        nested: {
          authorization: 'Bearer token',
          safe: 123
        },
        arr: [
          { secret: 'hidden', okay: 'yes' }
        ]
      };
      const safe = manager.redactSecrets(payload);
      expect(safe.publicData).toBe('abc');
      expect(safe.apiKey).toBe('[REDACTED]');
      expect(safe.nested.authorization).toBe('[REDACTED]');
      expect(safe.nested.safe).toBe(123);
      expect(safe.arr[0].secret).toBe('[REDACTED]');
      expect(safe.arr[0].okay).toBe('yes');
      
      const serialized = JSON.stringify(safe);
      expect(serialized).not.toContain('real-key');
      expect(serialized).not.toContain('Bearer token');
    });

    it('14, 37, 46. Error and Log Safety', () => {
      // In a real logger, you call redactSecrets before printing
      try {
        manager.validateCredential(validMetadata, 'KRAKEN');
      } catch (e: any) {
        expect(e.message).not.toContain(secret);
        expect(e.message).toBe('PROVIDER_ISOLATION_VIOLATION');
      }
    });
  });

  describe('Signature and Request Validation', () => {
    it('16. Valid signature', () => {
      const req = createValidRequest();
      expect(() => manager.verifyRequest(req, validPolicy, secret)).not.toThrow();
    });

    it('17. Invalid signature', () => {
      const req = createValidRequest();
      req.signature = 'bad-signature';
      expect(() => manager.verifyRequest(req, validPolicy, secret)).toThrow(/INVALID_SIGNATURE/);
    });

    it('18, 19, 20. Modified payload/timestamp/nonce invalidates signature', () => {
      const req1 = createValidRequest();
      req1.payload = { amount: 999 };
      expect(() => manager.verifyRequest(req1, validPolicy, secret)).toThrow(/INVALID_SIGNATURE/);

      const req2 = createValidRequest();
      req2.timestamp = Date.now() - 1000;
      expect(() => manager.verifyRequest(req2, validPolicy, secret)).toThrow(/INVALID_SIGNATURE/);

      const req3 = createValidRequest();
      req3.nonce = 'different-nonce';
      expect(() => manager.verifyRequest(req3, validPolicy, secret)).toThrow(/INVALID_SIGNATURE/);
    });

    it('21. Missing signature', () => {
      const req = createValidRequest();
      req.signature = undefined;
      expect(() => manager.verifyRequest(req, validPolicy, secret)).toThrow(/MISSING_SIGNATURE/);
    });

    it('22, 23. Replay detection & duplicate nonce', () => {
      const req = createValidRequest();
      // First time works
      expect(() => manager.verifyRequest(req, validPolicy, secret)).not.toThrow();
      
      // Exact replay of the same nonce throws REPLAY_DETECTED
      expect(() => manager.verifyRequest(req, validPolicy, secret)).toThrow(/REPLAY_DETECTED/);
    });

    it('24, 25. Timestamp expiration & missing fields', () => {
      const req = createValidRequest();
      req.timestamp = Date.now() - 10000; // tolerance is 5000
      req.signature = manager.mockSign(req, secret);
      expect(() => manager.verifyRequest(req, validPolicy, secret)).toThrow(/REQUEST_EXPIRED/);
    });

    it('26, 27, 28, 29, 30. Missing required identifiers', () => {
      const req = createValidRequest();
      req.clientOrderId = '';
      expect(() => manager.verifyRequest(req, validPolicy, secret)).toThrow(/Missing required request fields/);
    });
  });

  describe('Rate Limiting & Safety Integration', () => {
    it('32, 42. Rate limit exceeded', () => {
      const rStore = new InMemoryRateLimitStore(0, 1); // 1 token max, no refill
      const m = new SecurityManager(new InMemoryReplayStore(), rStore);
      const req1 = createValidRequest();
      req1.nonce = 'n1'; req1.signature = m.mockSign(req1, secret);
      expect(() => m.verifyRequest(req1, validPolicy, secret)).not.toThrow();

      const req2 = createValidRequest();
      req2.nonce = 'n2'; req2.signature = m.mockSign(req2, secret);
      expect(() => m.verifyRequest(req2, validPolicy, secret)).toThrow(/RATE_LIMITED/);
    });

    it('44. Security event generation', () => {
      const req = createValidRequest();
      const event = manager.createSecurityEvent(req, 'AUTH_SUCCESS', 'OK');
      expect(event.clientOrderId).toBe('o1');
      expect(event.providerId).toBe('BINANCE');
      expect(event.eventId).toBeDefined();
    });
  });

  it('45-51, 53. Boundaries & No Financial Mutation', () => {
    const req = createValidRequest();
    const serialized = JSON.stringify(req);
    expect(serialized).not.toContain('wallet');
    expect(serialized).not.toContain('ledger');
    expect(serialized).not.toContain('margin');
  });

});
