import { db, IDatabaseConnection } from '../../config/database';
import { auditService, AuditService } from './audit.service';
import { kycService, KycService } from '../compliance/kyc.service';
import {
  AdminUserSummary,
  AdminUserDetail,
  UpdateUserStatusDto,
  UpdateUserRoleDto,
} from '../../models/admin.model';
import { UserEntity, UserRole, AccountStatus } from '../../models/user.model';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export class AdminService {
  private audit: AuditService;
  private kyc: KycService;

  constructor(
    private database: IDatabaseConnection = db,
    audit?: AuditService,
    kyc?: KycService
  ) {
    this.audit = audit || new AuditService(database);
    this.kyc = kyc || new KycService(database);
  }

  /**
   * List all users with KYC and role filters
   */
  public async listUsers(params: {
    role?: UserRole;
    status?: AccountStatus;
    page?: number;
    pageSize?: number;
  }): Promise<{ users: AdminUserSummary[]; total: number }> {
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(100, Math.max(1, params.pageSize || 20));
    const offset = (page - 1) * pageSize;

    const conditions: string[] = [];
    const queryParams: any[] = [];

    if (params.role) {
      queryParams.push(params.role);
      conditions.push(`u.role = $${queryParams.length}`);
    }

    if (params.status) {
      queryParams.push(params.status);
      conditions.push(`u.account_status = $${queryParams.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countRes = await this.database.query<any>(
      `SELECT COUNT(*) AS total FROM users u ${whereClause}`,
      queryParams
    );
    const total = parseInt(countRes.rows[0]?.total || '0', 10);

    const limitIdx = queryParams.length + 1;
    const offsetIdx = queryParams.length + 2;
    queryParams.push(pageSize, offset);

    const usersRes = await this.database.query<any>(
      `SELECT u.id, u.email, u.role, u.account_status AS "accountStatus",
              COALESCE(k.tier, 'TIER_0') AS "kycTier",
              COALESCE(k.status, 'UNVERIFIED') AS "kycStatus",
              u.created_at AS "createdAt", u.updated_at AS "updatedAt"
       FROM users u
       LEFT JOIN user_kyc_profiles k ON u.id = k.user_id
       ${whereClause}
       ORDER BY u.created_at DESC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      queryParams
    );

    return {
      users: usersRes.rows,
      total,
    };
  }

  /**
   * Get detailed administrative inspection for a single user
   */
  public async getUserDetail(userId: string): Promise<AdminUserDetail> {
    const userRes = await this.database.query<any>(
      'SELECT id, email, role, account_status AS "accountStatus", created_at AS "createdAt", updated_at AS "updatedAt" FROM users WHERE id = $1',
      [userId]
    );

    if (userRes.rows.length === 0) {
      throw new AppError(`User "${userId}" not found`, 404, 'USER_NOT_FOUND');
    }

    const user: UserEntity = userRes.rows[0];

    const [kycProfile, accountsRes, sessionsRes, apiKeysRes] = await Promise.all([
      this.kyc.getProfile(userId),
      this.database.query<any>('SELECT id, user_id AS "userId", type, created_at AS "createdAt" FROM accounts WHERE user_id = $1', [userId]),
      this.database.query<any>("SELECT COUNT(*) AS count FROM user_sessions WHERE user_id = $1 AND status = 'ACTIVE'", [userId]),
      this.database.query<any>("SELECT COUNT(*) AS count FROM api_keys WHERE user_id = $1 AND status = 'ACTIVE'", [userId]),
    ]);

    return {
      user,
      kycProfile,
      accounts: accountsRes.rows,
      activeSessionsCount: parseInt(sessionsRes.rows[0]?.count || '0', 10),
      activeApiKeysCount: parseInt(apiKeysRes.rows[0]?.count || '0', 10),
    };
  }

  /**
   * Freeze / Suspend / Activate a user account
   */
  public async updateUserStatus(dto: UpdateUserStatusDto): Promise<UserEntity> {
    if (!dto.reason || !dto.reason.trim()) {
      throw new AppError('Reason is required for updating account status', 400, 'MISSING_REASON');
    }

    const userRes = await this.database.query<any>(
      'SELECT id, email, role, account_status AS "accountStatus" FROM users WHERE id = $1',
      [dto.userId]
    );

    if (userRes.rows.length === 0) {
      throw new AppError(`User "${dto.userId}" not found`, 404, 'USER_NOT_FOUND');
    }

    const current = userRes.rows[0];

    // Safeguard: Prevent admin from suspending themselves if they are the sole admin
    if (dto.adminUserId === dto.userId && dto.status !== 'ACTIVE' && current.role === 'ADMIN') {
      const adminCountRes = await this.database.query<any>(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE'"
      );
      const adminCount = parseInt(adminCountRes.rows[0]?.count || '0', 10);
      if (adminCount <= 1) {
        throw new AppError('Cannot suspend the sole active administrator account', 400, 'SOLE_ADMIN_PROTECTION');
      }
    }

    const updateRes = await this.database.query<any>(
      `UPDATE users
       SET account_status = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, role, account_status AS "accountStatus", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [dto.status, dto.userId]
    );

    const updatedUser = updateRes.rows[0];

    // If suspended or closed, invalidate all active sessions and API keys
    if (dto.status === 'SUSPENDED' || dto.status === 'CLOSED') {
      await Promise.all([
        this.database.query("UPDATE user_sessions SET status = 'REVOKED', last_active_at = NOW() WHERE user_id = $1 AND status = 'ACTIVE'", [dto.userId]),
        this.database.query("UPDATE api_keys SET status = 'REVOKED', updated_at = NOW() WHERE user_id = $1 AND status = 'ACTIVE'", [dto.userId]),
      ]);
      logger.warn('User suspended; revoked all active sessions and API keys', { userId: dto.userId, status: dto.status });
    }

    // Record immutable audit log
    await this.audit.record({
      adminUserId: dto.adminUserId,
      action: 'USER_STATUS_CHANGE',
      targetUserId: dto.userId,
      targetResourceType: 'USER',
      targetResourceId: dto.userId,
      previousState: { accountStatus: current.accountStatus },
      newState: { accountStatus: dto.status },
      reason: dto.reason.trim(),
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    return updatedUser;
  }

  /**
   * Update user role (e.g. promote to ADMIN or assign SYSTEM_BOT)
   */
  public async updateUserRole(dto: UpdateUserRoleDto): Promise<UserEntity> {
    if (!dto.reason || !dto.reason.trim()) {
      throw new AppError('Reason is required for updating user role', 400, 'MISSING_REASON');
    }

    const userRes = await this.database.query<any>(
      'SELECT id, email, role, account_status AS "accountStatus" FROM users WHERE id = $1',
      [dto.userId]
    );

    if (userRes.rows.length === 0) {
      throw new AppError(`User "${dto.userId}" not found`, 404, 'USER_NOT_FOUND');
    }

    const current = userRes.rows[0];

    // Safeguard: Prevent admin from demoting themselves if they are the sole admin
    if (dto.adminUserId === dto.userId && dto.role !== 'ADMIN' && current.role === 'ADMIN') {
      const adminCountRes = await this.database.query<any>(
        "SELECT COUNT(*) AS count FROM users WHERE role = 'ADMIN' AND account_status = 'ACTIVE'"
      );
      const adminCount = parseInt(adminCountRes.rows[0]?.count || '0', 10);
      if (adminCount <= 1) {
        throw new AppError('Cannot demote the sole active administrator account', 400, 'SOLE_ADMIN_PROTECTION');
      }
    }

    const updateRes = await this.database.query<any>(
      `UPDATE users
       SET role = $1, updated_at = NOW()
       WHERE id = $2
       RETURNING id, email, role, account_status AS "accountStatus", created_at AS "createdAt", updated_at AS "updatedAt"`,
      [dto.role, dto.userId]
    );

    const updatedUser = updateRes.rows[0];

    // Record immutable audit log
    await this.audit.record({
      adminUserId: dto.adminUserId,
      action: 'USER_ROLE_CHANGE',
      targetUserId: dto.userId,
      targetResourceType: 'USER',
      targetResourceId: dto.userId,
      previousState: { role: current.role },
      newState: { role: dto.role },
      reason: dto.reason.trim(),
      ipAddress: dto.ipAddress,
      userAgent: dto.userAgent,
    });

    return updatedUser;
  }
}

export const adminService = new AdminService();
