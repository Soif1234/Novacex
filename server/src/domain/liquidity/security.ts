import { ProviderError, ProviderErrorCode } from './errors';
import * as crypto from 'crypto';
import { StateSafetyClassification, IStatefulComponent } from './classification';

export enum ProviderOperation {
  READ_MARKET_DATA = 'READ_MARKET_DATA',
  READ_BALANCE = 'READ_BALANCE',
  CREATE_ORDER = 'CREATE_ORDER',
  CANCEL_ORDER = 'CANCEL_ORDER',
  READ_ORDER = 'READ_ORDER',
  READ_TRADES = 'READ_TRADES',
  WITHDRAW = 'WITHDRAW',
  TRANSFER_FUNDS = 'TRANSFER_FUNDS',
  CHANGE_SECURITY_SETTINGS = 'CHANGE_SECURITY_SETTINGS'
}

export type CredentialStatus = 'ACTIVE' | 'EXPIRING' | 'EXPIRED' | 'REVOKED';

export interface ProviderSecurityPolicy {
  providerId: string;
  allowedOperations: Set<ProviderOperation>;
  withdrawalAllowed: boolean;
  maxRequestRate: number;
  credentialRotationRequired: boolean;
  signingRequired: boolean;
  timestampTolerance: number;
  nonceRequired: boolean;
}

export interface ProviderCredentialMetadata {
  providerId: string;
  credentialId: string;
  createdAt: number;
  expiresAt: number;
  status: CredentialStatus;
  permissions: Set<ProviderOperation>;
}

export interface SignedRequest {
  providerId: string;
  clientOrderId: string;
  requestId: string;
  operation: ProviderOperation;
  timestamp: number;
  nonce?: string;
  signature?: string;
  payload: any;
}

export interface SecurityEvent {
  eventId: string;
  providerId: string;
  operation: string;
  requestId: string;
  clientOrderId: string;
  eventType: string;
  result: string;
  timestamp: number;
}

export interface ReplayProtectionStore {
  hasSeen(providerId: string, nonce: string): boolean;
  record(providerId: string, nonce: string, ttlMs: number): void;
}

export interface ProviderRateLimitStore {
  consume(providerId: string, tokens: number): boolean;
}

export class InMemoryReplayStore implements ReplayProtectionStore, IStatefulComponent {
  private seen: Map<string, number> = new Map();

  public hasSeen(providerId: string, nonce: string): boolean {
    const key = `${providerId}:${nonce}`;
    const expiry = this.seen.get(key);
    if (expiry && expiry > Date.now()) {
      return true;
    }
    return false;
  }

  public record(providerId: string, nonce: string, ttlMs: number): void {
    const key = `${providerId}:${nonce}`;
    this.seen.set(key, Date.now() + ttlMs);
  }

  getSafetyClassification(): StateSafetyClassification {
    return StateSafetyClassification.DISTRIBUTED_REQUIRED;
  }
}

export class InMemoryRateLimitStore implements ProviderRateLimitStore, IStatefulComponent {
  private limits: Map<string, { tokens: number; lastRefill: number }> = new Map();

  constructor(private readonly refillRatePerSec: number, private readonly maxTokens: number) {}

  public consume(providerId: string, tokens: number): boolean {
    const now = Date.now();
    let bucket = this.limits.get(providerId) || { tokens: this.maxTokens, lastRefill: now };
    
    // Refill
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(this.maxTokens, bucket.tokens + elapsed * this.refillRatePerSec);
    bucket.lastRefill = now;

    if (bucket.tokens >= tokens) {
      bucket.tokens -= tokens;
      this.limits.set(providerId, bucket);
      return true;
    }
    return false;
  }

  getSafetyClassification(): StateSafetyClassification {
    return StateSafetyClassification.DISTRIBUTED_REQUIRED;
  }
}

export class SecurityManager {
  private readonly SENSITIVE_KEYS = new Set([
    'apikey', 'apisecret', 'secret', 'password', 'token', 
    'authorization', 'signature', 'privatekey', 'credential', 'accesstoken'
  ]);

  constructor(
    private replayStore: ReplayProtectionStore,
    private rateLimitStore: ProviderRateLimitStore
  ) {}

  public validatePolicy(policy: ProviderSecurityPolicy): void {
    if (policy.withdrawalAllowed === true) {
      throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'SECURITY_POLICY_VIOLATION: withdrawalAllowed must be false', policy.providerId);
    }
    
    const forbidden = [ProviderOperation.WITHDRAW, ProviderOperation.TRANSFER_FUNDS, ProviderOperation.CHANGE_SECURITY_SETTINGS];
    for (const op of forbidden) {
      if (policy.allowedOperations.has(op)) {
        throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, `SECURITY_POLICY_VIOLATION: ${op} permission is permanently blocked`, policy.providerId);
      }
    }
    
    if (policy.maxRequestRate <= 0 || !isFinite(policy.maxRequestRate)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'SECURITY_POLICY_VIOLATION: Invalid maxRequestRate', policy.providerId);
    }
    if (policy.timestampTolerance <= 0 || !isFinite(policy.timestampTolerance)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'SECURITY_POLICY_VIOLATION: Invalid timestampTolerance', policy.providerId);
    }
  }

  public validateCredential(metadata: ProviderCredentialMetadata, expectedProviderId: string): void {
    if (metadata.providerId !== expectedProviderId) {
      throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'PROVIDER_ISOLATION_VIOLATION', metadata.providerId);
    }
    if (metadata.status === 'REVOKED') {
      throw new ProviderError(ProviderErrorCode.AUTHENTICATION_FAILURE, 'CREDENTIAL_REVOKED', metadata.providerId);
    }
    if (metadata.status === 'EXPIRED' || Date.now() > metadata.expiresAt) {
      throw new ProviderError(ProviderErrorCode.AUTHENTICATION_FAILURE, 'CREDENTIAL_EXPIRED', metadata.providerId);
    }
  }

  public authorizeOperation(metadata: ProviderCredentialMetadata, operation: ProviderOperation): void {
    const forbidden = [ProviderOperation.WITHDRAW, ProviderOperation.TRANSFER_FUNDS, ProviderOperation.CHANGE_SECURITY_SETTINGS];
    if (forbidden.includes(operation)) {
      throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'PERMISSION_DENIED', metadata.providerId);
    }
    if (!metadata.permissions.has(operation)) {
      throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'PERMISSION_DENIED', metadata.providerId);
    }
  }

  public verifyRequest(req: SignedRequest, policy: ProviderSecurityPolicy, signatureSecret: string): void {
    if (!req.providerId || !req.requestId || !req.clientOrderId || !req.operation) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Missing required request fields', req.providerId || 'UNKNOWN');
    }
    
    // Check Rate Limit
    if (!this.rateLimitStore.consume(req.providerId, 1)) {
       throw new ProviderError(ProviderErrorCode.RATE_LIMIT, 'RATE_LIMITED', req.providerId);
    }

    // Check Timestamp
    const now = Date.now();
    if (!req.timestamp || isNaN(req.timestamp)) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Missing or invalid timestamp', req.providerId);
    }
    const diff = Math.abs(now - req.timestamp);
    if (diff > policy.timestampTolerance) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'REQUEST_EXPIRED', req.providerId);
    }

    // Check Nonce & Replay
    if (policy.nonceRequired) {
      if (!req.nonce) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Missing nonce', req.providerId);
      }
      if (this.replayStore.hasSeen(req.providerId, req.nonce)) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'REPLAY_DETECTED', req.providerId);
      }
      this.replayStore.record(req.providerId, req.nonce, policy.timestampTolerance * 2);
    }

    // Check Signature
    if (policy.signingRequired) {
      if (!req.signature) {
        throw new ProviderError(ProviderErrorCode.AUTHENTICATION_FAILURE, 'MISSING_SIGNATURE', req.providerId);
      }
      
      const expectedSignature = this.mockSign(req, signatureSecret);
      if (req.signature !== expectedSignature) {
        throw new ProviderError(ProviderErrorCode.AUTHENTICATION_FAILURE, 'INVALID_SIGNATURE', req.providerId);
      }
    }
  }

  public redactSecrets(payload: any): any {
    if (payload === null || payload === undefined) {
      return payload;
    }
    
    if (Array.isArray(payload)) {
      return payload.map(item => this.redactSecrets(item));
    }
    
    if (typeof payload === 'object') {
      const redacted: any = {};
      for (const key of Object.keys(payload)) {
        if (this.SENSITIVE_KEYS.has(key.toLowerCase())) {
          redacted[key] = '[REDACTED]';
        } else {
          redacted[key] = this.redactSecrets(payload[key]);
        }
      }
      return redacted;
    }
    
    return payload;
  }

  // Purely deterministic mock signing algorithm
  public mockSign(req: SignedRequest, secret: string): string {
    const payloadStr = typeof req.payload === 'object' ? JSON.stringify(req.payload) : String(req.payload);
    const data = `${req.providerId}:${req.operation}:${req.timestamp}:${req.nonce || ''}:${payloadStr}:${secret}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  public createSecurityEvent(req: SignedRequest, eventType: string, result: string): SecurityEvent {
    return {
      eventId: crypto.randomUUID(),
      providerId: req.providerId,
      operation: req.operation,
      requestId: req.requestId,
      clientOrderId: req.clientOrderId,
      eventType,
      result,
      timestamp: Date.now()
    };
  }
}
