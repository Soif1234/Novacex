import { UserRole, AccountStatus, UserEntity } from './user.model';
import { KycTier, KycStatus, UserKycProfileEntity } from './kyc.model';
import { AccountEntity } from './account.model';

export type AdminAuditAction =
  | 'USER_STATUS_CHANGE'
  | 'USER_ROLE_CHANGE'
  | 'KYC_REVIEW'
  | 'SANCTION_ADDED'
  | 'SANCTION_REMOVED'
  | 'SYSTEM_HALT'
  | 'SYSTEM_RESUME'
  | 'PAPER_DEPOSIT_ADMIN'
  | 'MANUAL_LEDGER_ADJUSTMENT'
  | 'RESOLVE_WITHDRAWAL';

export interface AdminAuditLogEntity {
  id: string;
  adminUserId: string;
  action: AdminAuditAction | string;
  targetUserId?: string;
  targetResourceType: string;
  targetResourceId?: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
  createdAt: Date;
}

export interface RecordAuditLogDto {
  adminUserId: string;
  action: AdminAuditAction | string;
  targetUserId?: string;
  targetResourceType?: string;
  targetResourceId?: string;
  previousState?: Record<string, unknown> | null;
  newState?: Record<string, unknown> | null;
  reason?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface QueryAuditLogsDto {
  adminUserId?: string;
  targetUserId?: string;
  action?: string;
  page?: number;
  pageSize?: number;
}

export interface UpdateUserStatusDto {
  adminUserId: string;
  userId: string;
  status: AccountStatus;
  reason: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface UpdateUserRoleDto {
  adminUserId: string;
  userId: string;
  role: UserRole;
  reason: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface AdminUserSummary {
  id: string;
  email: string;
  role: UserRole;
  accountStatus: AccountStatus;
  kycTier: KycTier;
  kycStatus: KycStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AdminUserDetail {
  user: UserEntity;
  kycProfile: UserKycProfileEntity;
  accounts: AccountEntity[];
  activeSessionsCount: number;
  activeApiKeysCount: number;
}
