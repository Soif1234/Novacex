export type UserRole = 'USER' | 'ADMIN' | 'SYSTEM_BOT';
export type AccountStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type SessionStatus = 'ACTIVE' | 'REVOKED' | 'EXPIRED';

export interface UserEntity {
  id: string;
  email: string;
  role: UserRole;
  accountStatus: AccountStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserProfileEntity {
  userId: string;
  username: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserAuthCredentialsEntity {
  userId: string;
  passwordHash: string;
  twoFactorSecret?: string;
  twoFactorEnabled: boolean;
  failedLoginAttempts: number;
  lockedUntil?: Date;
  lastLoginAt?: Date;
  updatedAt: Date;
}

export interface UserSessionEntity {
  id: string;
  userId: string;
  tokenHash: string;
  ipAddress?: string;
  userAgent?: string;
  status: SessionStatus;
  expiresAt: Date;
  createdAt: Date;
  lastActiveAt: Date;
}
