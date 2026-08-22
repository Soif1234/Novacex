export type ApiKeyPermission = 'READ' | 'TRADE' | 'WITHDRAW';
export type ApiKeyStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface ApiKeyEntity {
  id: string;
  userId: string;
  keyId: string;
  secretHash: string;
  encryptedSecret: string;
  secretPreview: string;
  label: string;
  permissions: ApiKeyPermission[];
  ipWhitelist: string[];
  status: ApiKeyStatus;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateApiKeyDto {
  userId: string;
  label: string;
  permissions?: ApiKeyPermission[];
  ipWhitelist?: string[];
  expiresAt?: Date;
}

export interface SafeApiKey {
  id: string;
  keyId: string;
  label: string;
  secretPreview: string;
  permissions: ApiKeyPermission[];
  ipWhitelist: string[];
  status: ApiKeyStatus;
  lastUsedAt?: Date;
  expiresAt?: Date;
  createdAt: Date;
}

export interface CreatedApiKeyResult extends SafeApiKey {
  secret: string; // Plaintext secret displayed ONCE ONLY
}
