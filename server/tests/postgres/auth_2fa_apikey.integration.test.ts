import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { AuthService } from '../../src/services/auth/auth.service';
import { SessionService } from '../../src/services/auth/session.service';
import { ApiKeyService } from '../../src/services/auth/api-key.service';
import { totpService } from '../../src/services/auth/totp.service';

describe('Phase 7.1: PostgreSQL 2FA & API Key Integration Tests', () => {
  let pgPool: PostgresDatabasePool;
  let authService: AuthService;
  let apiKeyService: ApiKeyService;
  let sessionService: SessionService;
  const testEmail = `pg_user_71_${Date.now()}@test.exchange`;
  const testPassword = 'Password123!SecurePg';
  let userId: string;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    pgPool = new PostgresDatabasePool();
    await pgPool.connect();

    const migrator = new SchemaMigrator(undefined, pgPool);
    await migrator.runMigrations();

    sessionService = new SessionService(pgPool);
    authService = new AuthService(pgPool, sessionService, totpService);
    apiKeyService = new ApiKeyService(pgPool);
  });

  afterAll(async () => {
    if (pgPool) {
      await pgPool.close();
    }
  });

  it('1. Signs up user in PostgreSQL and sets up TOTP 2FA', async () => {
    const signupRes = await authService.signup({
      email: testEmail,
      password: testPassword,
      username: `pguser71_${Date.now().toString().slice(-4)}`
    });

    userId = signupRes.user.id;
    expect(userId).toBeDefined();

    // Verify 2FA setup in PostgreSQL
    const setup = await authService.setup2FA(userId);
    expect(setup.secret).toBeDefined();
    expect(setup.otpauthUri).toContain('otpauth://totp/');

    // Inspect real postgres user_auth_credentials table
    const credsRes = await pgPool.query<any>(
      'SELECT two_factor_secret, two_factor_enabled FROM user_auth_credentials WHERE user_id = $1',
      [userId]
    );
    expect(credsRes.rows[0].two_factor_secret).toBe(setup.secret);
    expect(credsRes.rows[0].two_factor_enabled).toBe(false);

    // Enable 2FA with valid TOTP token
    const token = totpService.generateToken(setup.secret);
    const enabled = await authService.enable2FA(userId, token);
    expect(enabled).toBe(true);

    const verifiedCreds = await pgPool.query<any>(
      'SELECT two_factor_enabled FROM user_auth_credentials WHERE user_id = $1',
      [userId]
    );
    expect(verifiedCreds.rows[0].two_factor_enabled).toBe(true);
  });

  it('2. Login challenge workflow in PostgreSQL with 2FA enforcement', async () => {
    // Attempt standard login without 2FA
    const challengeRes = await authService.login({
      email: testEmail,
      password: testPassword,
    });

    expect(challengeRes.requires2FA).toBe(true);
    expect(challengeRes.tempToken).toBeDefined();
    expect(challengeRes.sessionToken).toBeUndefined();

    // Fetch secret from DB and generate code
    const credsRes = await pgPool.query<any>(
      'SELECT two_factor_secret FROM user_auth_credentials WHERE user_id = $1',
      [userId]
    );
    const secret = credsRes.rows[0].two_factor_secret;
    const token = totpService.generateToken(secret);

    // Verify challenge
    const verified = await authService.verify2FALogin(challengeRes.tempToken!, token);
    expect(verified.sessionToken).toBeDefined();
    expect(verified.user.id).toBe(userId);
    expect(verified.user.twoFactorEnabled).toBe(true);
  });

  it('3. Creates scoped API key in PostgreSQL with AES-256-GCM encryption & HMAC verification', async () => {
    const createdKey = await apiKeyService.createApiKey({
      userId,
      label: 'PostgreSQL Trading Bot',
      permissions: ['READ', 'TRADE'],
      ipWhitelist: ['127.0.0.1'],
    });

    expect(createdKey.keyId).toMatch(/^novak_live_/);
    expect(createdKey.secret).toMatch(/^novas_live_/);

    // Inspect database record in PostgreSQL
    const dbRowRes = await pgPool.query<any>(
      'SELECT * FROM api_keys WHERE key_id = $1',
      [createdKey.keyId]
    );
    expect(dbRowRes.rows.length).toBe(1);
    const dbRow = dbRowRes.rows[0];

    // Verify secret is NEVER stored plaintext
    expect(dbRow.encrypted_secret).not.toBe(createdKey.secret);
    expect(dbRow.encrypted_secret).toContain(':'); // IV:tag:ciphertext format
    expect(dbRow.secret_hash).toBe(crypto.createHash('sha256').update(createdKey.secret).digest('hex'));
    expect(dbRow.secret_preview).toBe(`...${createdKey.secret.slice(-4)}`);
    expect(dbRow.permissions).toEqual(['READ', 'TRADE']);
    expect(dbRow.status).toBe('ACTIVE');

    // Test HMAC-SHA256 verification against real PostgreSQL data
    const timestamp = Date.now();
    const nonce = `pg_nonce_${Date.now()}`;
    const method = 'POST';
    const path = '/api/v1/spot/orders';
    const bodyString = JSON.stringify({ symbol: 'BTCUSDT', side: 'BUY' });
    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', createdKey.secret).update(payload).digest('hex');

    const authResult = await apiKeyService.verifySignedRequest({
      keyId: createdKey.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      clientIp: '127.0.0.1',
      requiredPermission: 'TRADE',
    });

    expect(authResult.valid).toBe(true);
    expect(authResult.userId).toBe(userId);
  });

  it('4. Revokes API key in PostgreSQL and verifies atomic rejection', async () => {
    const createdKey = await apiKeyService.createApiKey({
      userId,
      label: 'Temporary Bot',
      permissions: ['READ'],
    });

    const revoked = await apiKeyService.revokeApiKey(userId, createdKey.keyId);
    expect(revoked).toBe(true);

    const checkDb = await pgPool.query<any>(
      'SELECT status FROM api_keys WHERE key_id = $1',
      [createdKey.keyId]
    );
    expect(checkDb.rows[0].status).toBe('REVOKED');

    const timestamp = Date.now();
    const nonce = `rev_nonce_${Date.now()}`;
    const payload = `${timestamp}${nonce}GET/api/v1/wallet/balances`;
    const signature = crypto.createHmac('sha256', createdKey.secret).update(payload).digest('hex');

    const authResult = await apiKeyService.verifySignedRequest({
      keyId: createdKey.keyId,
      timestamp,
      nonce,
      method: 'GET',
      path: '/api/v1/wallet/balances',
      bodyString: '',
      signature,
      requiredPermission: 'READ',
    });

    expect(authResult.valid).toBe(false);
    expect(authResult.error).toMatch(/API key is revoked/);
  });
});
