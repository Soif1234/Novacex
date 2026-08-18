export type AccountStatus = 'ACTIVE' | 'SUSPENDED';

export type SecurityLevel = 'BASIC' | 'ENHANCED';
export type SessionStatus = 'ACTIVE' | 'REVOKED';

export interface SecurityStatus {
  twoFactorEnabled: boolean;
  sessionCount: number;
  lastLoginAt: number | null;
  securityLevel: SecurityLevel;
}

export interface LoginSession {
  id: string;
  deviceName: string;
  platform: string;
  createdAt: number;
  lastActiveAt: number;
  current: boolean;
  status: SessionStatus;
}

export interface User {
  id: string;
  username: string;
  displayName: string;
  email?: string;
  avatar?: string;
  accountStatus: AccountStatus;
  createdAt: number;
  lastActiveAt: number;
}
