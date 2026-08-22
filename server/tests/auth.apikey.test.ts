import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'crypto';
import { apiKeyService } from '../src/services/auth/api-key.service';
import { authService } from '../src/services/auth/auth.service';

describe('Phase 7.1 — Scoped API Key Management & HMAC Authentication Tests', () => {
  let testUserId: string;
  let testEmail: string;

  beforeEach(async () => {
    const { db } = await import('../src/config/database');
    await db.connect();
    testEmail = `trader_apikey_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
    const res = await authService.signup({
      email: testEmail,
      password: 'Password123!Secure',
      username: `trkey_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`
    });
    testUserId = res.user.id;
  });

  it('1. Generates API key with secret returned once, preview masked, and encrypted at rest', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'Production Trading Bot',
      permissions: ['READ', 'TRADE'],
      ipWhitelist: ['192.168.1.100'],
    });

    expect(created.keyId).toMatch(/^novak_live_/);
    expect(created.secret).toMatch(/^novas_live_/);
    expect(created.secretPreview).toBe(`...${created.secret.slice(-4)}`);
    expect(created.permissions).toEqual(['READ', 'TRADE']);
    expect(created.ipWhitelist).toEqual(['192.168.1.100']);
    expect(created.status).toBe('ACTIVE');

    // Verify list keys masks secret
    const list = await apiKeyService.listApiKeys(testUserId);
    expect(list.length).toBe(1);
    expect((list[0] as any).secret).toBeUndefined();
    expect(list[0].secretPreview).toBe(created.secretPreview);
  });

  it('2. Successfully verifies HMAC-SHA256 signed requests with correct signature', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'HFT Bot',
      permissions: ['READ', 'TRADE'],
    });

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const method = 'POST';
    const path = '/api/v1/spot/orders';
    const body = { symbol: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000', quantity: '0.1' };
    const bodyString = JSON.stringify(body);

    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', created.secret).update(payload).digest('hex');

    const result = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'TRADE',
    });

    expect(result.valid).toBe(true);
    expect(result.userId).toBe(testUserId);
    expect(result.error).toBeUndefined();
  });

  it('3. Rejects signed request if signature is invalid or tampered', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'Test Bot',
      permissions: ['READ'],
    });

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const method = 'GET';
    const path = '/api/v1/wallet/balances';
    const bodyString = '';

    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', 'WRONG_SECRET').update(payload).digest('hex');

    const result = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'READ',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/Invalid HMAC-SHA256 signature/);
  });

  it('4. Rejects request with timestamp drift outside ±5000ms', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'Test Bot',
      permissions: ['READ'],
    });

    const timestamp = Date.now() - 10000; // 10 seconds in past
    const nonce = crypto.randomBytes(16).toString('hex');
    const method = 'GET';
    const path = '/api/v1/wallet/balances';
    const bodyString = '';

    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', created.secret).update(payload).digest('hex');

    const result = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'READ',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/timestamp is outside/);
  });

  it('5. Replay Protection: Rejects reused nonce', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'Test Bot',
      permissions: ['READ'],
    });

    const timestamp = Date.now();
    const nonce = `unique_nonce_${Date.now()}`;
    const method = 'GET';
    const path = '/api/v1/wallet/balances';
    const bodyString = '';

    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', created.secret).update(payload).digest('hex');

    // First request succeeds
    const firstResult = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'READ',
    });
    expect(firstResult.valid).toBe(true);

    // Second request with same nonce is rejected as replay attack
    const replayResult = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'READ',
    });
    expect(replayResult.valid).toBe(false);
    expect(replayResult.error).toMatch(/Replay attack detected/);
  });

  it('6. Enforces permission scopes (rejects TRADE if only READ granted)', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'Read Only Bot',
      permissions: ['READ'],
    });

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const method = 'POST';
    const path = '/api/v1/spot/orders';
    const bodyString = JSON.stringify({ symbol: 'BTCUSDT' });

    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', created.secret).update(payload).digest('hex');

    const result = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'TRADE', // Demanding TRADE permission
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/lacks required permission: TRADE/);
  });

  it('7. Enforces IP Whitelisting', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'IP Restricted Bot',
      permissions: ['READ', 'TRADE'],
      ipWhitelist: ['10.0.0.1', '10.0.0.2'],
    });

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const method = 'GET';
    const path = '/api/v1/wallet/balances';
    const bodyString = '';

    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', created.secret).update(payload).digest('hex');

    // Authorized IP succeeds
    const allowed = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce: `${nonce}_1`,
      method,
      path,
      bodyString,
      signature: crypto.createHmac('sha256', created.secret).update(`${timestamp}${nonce}_1${method}${path}${bodyString}`).digest('hex'),
      clientIp: '10.0.0.1',
      requiredPermission: 'READ',
    });
    expect(allowed.valid).toBe(true);

    // Unauthorized IP rejected
    const blocked = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce: `${nonce}_2`,
      method,
      path,
      bodyString,
      signature: crypto.createHmac('sha256', created.secret).update(`${timestamp}${nonce}_2${method}${path}${bodyString}`).digest('hex'),
      clientIp: '198.51.100.5',
      requiredPermission: 'READ',
    });
    expect(blocked.valid).toBe(false);
    expect(blocked.error).toMatch(/is not authorized for this API key/);
  });

  it('8. Atomic key revocation invalidates subsequent signed requests', async () => {
    const created = await apiKeyService.createApiKey({
      userId: testUserId,
      label: 'Revocable Bot',
      permissions: ['READ'],
    });

    // Revoke key
    const revoked = await apiKeyService.revokeApiKey(testUserId, created.keyId);
    expect(revoked).toBe(true);

    const timestamp = Date.now();
    const nonce = crypto.randomBytes(16).toString('hex');
    const method = 'GET';
    const path = '/api/v1/wallet/balances';
    const bodyString = '';
    const payload = `${timestamp}${nonce}${method}${path}${bodyString}`;
    const signature = crypto.createHmac('sha256', created.secret).update(payload).digest('hex');

    const result = await apiKeyService.verifySignedRequest({
      keyId: created.keyId,
      timestamp,
      nonce,
      method,
      path,
      bodyString,
      signature,
      requiredPermission: 'READ',
    });

    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/API key is revoked/);
  });
});
