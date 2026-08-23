import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { env } from '../../config/env';
import {
  ApiKeyEntity,
  ApiKeyPermission,
  CreateApiKeyDto,
  SafeApiKey,
  CreatedApiKeyResult,
} from '../../models/api-key.model';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export class ApiKeyService {
  private encryptionKey: Buffer;
  private seenNonces: Map<string, number> = new Map(); // keyId:nonce -> expiryTime

  constructor(private database: IDatabaseConnection = db) {
    let secret = env.API_KEY_ENCRYPTION_SECRET;
    if (!secret) {
      if (process.env.NODE_ENV === 'production') {
        throw new Error('FATAL: API_KEY_ENCRYPTION_SECRET must be set in production environment');
      } else {
        secret = 'default_mallick_api_encryption_key_change_in_prod';
      }
    }
    this.encryptionKey = crypto.createHash('sha256').update(secret).digest();
  }

  /**
   * Encrypt plaintext secret using AES-256-GCM
   */
  private encryptSecret(plaintext: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  /**
   * Decrypt AES-256-GCM encrypted secret
   */
  private decryptSecret(encryptedPayload: string): string {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted secret format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = Buffer.from(parts[2], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', this.encryptionKey, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  /**
   * Create a new scoped API Key for a user.
   * Returns plaintext secret ONCE ONLY.
   */
  public async createApiKey(dto: CreateApiKeyDto): Promise<CreatedApiKeyResult> {
    if (!dto.label || dto.label.trim().length === 0) {
      throw new AppError('API key label is required', 400, 'INVALID_LABEL');
    }

    const permissions: ApiKeyPermission[] = dto.permissions && dto.permissions.length > 0
      ? dto.permissions
      : ['READ'];

    const validPermissions: ApiKeyPermission[] = ['READ', 'TRADE', 'WITHDRAW'];
    for (const p of permissions) {
      if (!validPermissions.includes(p)) {
        throw new AppError(`Invalid API key permission: ${p}`, 400, 'INVALID_PERMISSION');
      }
    }

    const keyId = `novak_live_${crypto.randomBytes(16).toString('hex')}`;
    const secret = `novas_live_${crypto.randomBytes(32).toString('hex')}`;
    const secretHash = crypto.createHash('sha256').update(secret).digest('hex');
    const encryptedSecret = this.encryptSecret(secret);
    const secretPreview = `...${secret.slice(-4)}`;
    const ipWhitelist = dto.ipWhitelist || [];

    const res = await this.database.query<any>(
      `INSERT INTO api_keys (
        user_id, key_id, secret_hash, encrypted_secret, secret_preview, label, permissions, ip_whitelist, status, expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ACTIVE', $9)
      RETURNING id, user_id, key_id, secret_preview, label, permissions, ip_whitelist, status, last_used_at, expires_at, created_at`,
      [
        dto.userId,
        keyId,
        secretHash,
        encryptedSecret,
        secretPreview,
        dto.label.trim(),
        permissions,
        ipWhitelist,
        dto.expiresAt || null,
      ]
    );

    const row = res.rows[0];

    logger.info('Created new API key', { userId: dto.userId, keyId, label: dto.label });

    return {
      id: row.id,
      keyId: row.key_id,
      secret, // Plaintext secret returned ONCE
      label: row.label,
      secretPreview: row.secret_preview,
      permissions: row.permissions,
      ipWhitelist: row.ip_whitelist || [],
      status: row.status,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
    };
  }

  /**
   * List all API keys for a user (secrets are masked).
   */
  public async listApiKeys(userId: string): Promise<SafeApiKey[]> {
    const res = await this.database.query<any>(
      `SELECT id, key_id, label, secret_preview, permissions, ip_whitelist, status, last_used_at, expires_at, created_at
       FROM api_keys
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId]
    );

    return res.rows.map((row) => ({
      id: row.id,
      keyId: row.key_id,
      label: row.label,
      secretPreview: row.secret_preview,
      permissions: row.permissions || [],
      ipWhitelist: row.ip_whitelist || [],
      status: row.status,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at) : undefined,
      expiresAt: row.expires_at ? new Date(row.expires_at) : undefined,
      createdAt: new Date(row.created_at),
    }));
  }

  /**
   * Revoke an API key.
   */
  public async revokeApiKey(userId: string, keyIdOrId: string): Promise<boolean> {
    const res = await this.database.query<any>(
      `UPDATE api_keys
       SET status = 'REVOKED', updated_at = NOW()
       WHERE user_id = $1 AND (key_id = $2 OR id::text = $2) AND status = 'ACTIVE'
       RETURNING id, key_id`,
      [userId, keyIdOrId]
    );

    if (res.rows.length > 0) {
      logger.info('Revoked API key', { userId, keyId: res.rows[0].key_id });
      return true;
    }
    return false;
  }

  /**
   * Verify an incoming signed HMAC-SHA256 API request.
   */
  public async verifySignedRequest(params: {
    keyId: string;
    timestamp: number;
    nonce: string;
    method: string;
    path: string;
    bodyString: string;
    signature: string;
    clientIp?: string;
    requiredPermission?: ApiKeyPermission;
  }): Promise<{ valid: boolean; userId?: string; error?: string }> {
    const { keyId, timestamp, nonce, method, path, bodyString, signature, clientIp, requiredPermission } = params;

    // 1. Timestamp Drift Check (±5000ms)
    const now = Date.now();
    if (Math.abs(now - timestamp) > 5000) {
      return { valid: false, error: 'Request timestamp is outside the ±5000ms allowed window' };
    }

    // 2. Replay Protection (Nonce check)
    const nonceKey = `${keyId}:${nonce}`;
    this.cleanExpiredNonces();
    if (this.seenNonces.has(nonceKey)) {
      return { valid: false, error: 'Replay attack detected: Nonce has already been used' };
    }

    // 3. Fetch API Key from DB
    const res = await this.database.query<any>(
      `SELECT id, user_id, key_id, encrypted_secret, permissions, ip_whitelist, status, expires_at
       FROM api_keys
       WHERE key_id = $1`,
      [keyId]
    );

    const apiKey = res.rows[0];
    if (!apiKey) {
      return { valid: false, error: 'API key not found' };
    }

    if (apiKey.status !== 'ACTIVE') {
      return { valid: false, error: `API key is ${apiKey.status.toLowerCase()}` };
    }

    if (apiKey.expires_at && new Date(apiKey.expires_at).getTime() <= now) {
      return { valid: false, error: 'API key has expired' };
    }

    // 4. IP Whitelist Check
    const ipWhitelist: string[] = apiKey.ip_whitelist || [];
    if (ipWhitelist.length > 0 && clientIp) {
      const allowed = ipWhitelist.some((ip) => ip.trim() === clientIp.trim());
      if (!allowed) {
        return { valid: false, error: `IP ${clientIp} is not authorized for this API key` };
      }
    }

    // 5. Permission Scope Check
    const permissions: ApiKeyPermission[] = apiKey.permissions || [];
    if (requiredPermission && !permissions.includes(requiredPermission)) {
      return { valid: false, error: `API key lacks required permission: ${requiredPermission}` };
    }

    // 6. Decrypt secret and compute expected HMAC-SHA256 signature
    let secret: string;
    try {
      secret = this.decryptSecret(apiKey.encrypted_secret);
    } catch {
      return { valid: false, error: 'Failed to decrypt API key secret' };
    }

    const payloadToSign = `${timestamp}${nonce}${method.toUpperCase()}${path}${bodyString || ''}`;
    const expectedSignature = crypto.createHmac('sha256', secret).update(payloadToSign).digest('hex');

    // 7. Constant-time signature comparison
    if (
      signature.length !== expectedSignature.length ||
      !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))
    ) {
      return { valid: false, error: 'Invalid HMAC-SHA256 signature' };
    }

    // 8. Record Nonce (expire after 10 seconds)
    this.seenNonces.set(nonceKey, now + 10000);

    // 9. Update last_used_at asynchronously
    this.database.query(
      `UPDATE api_keys SET last_used_at = NOW() WHERE id = $1`,
      [apiKey.id]
    ).catch((err) => logger.error('Failed to update last_used_at for API key', { keyId, error: err }));

    return { valid: true, userId: apiKey.user_id };
  }

  private cleanExpiredNonces(): void {
    const now = Date.now();
    for (const [k, expiry] of this.seenNonces.entries()) {
      if (expiry <= now) {
        this.seenNonces.delete(k);
      }
    }
  }
}

export const apiKeyService = new ApiKeyService();
