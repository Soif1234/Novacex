import { Request, Response, NextFunction } from 'express';
import { adminService } from '../services/admin/admin.service';
import { auditService } from '../services/admin/audit.service';
import { AppError } from '../middleware/errorHandler';
import { UserRole, AccountStatus } from '../models/user.model';

export class AdminController {
  /**
   * GET /api/v1/admin/users
   * Paginated list of users with role, status, and KYC info
   */
  public static async listUsers(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const role = req.query.role as UserRole | undefined;
      const status = req.query.status as AccountStatus | undefined;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20;

      const result = await adminService.listUsers({ role, status, page, pageSize });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/users/:userId
   * Full administrative detail of a specific user
   */
  public static async getUserDetail(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { userId } = req.params;
      if (!userId) {
        throw new AppError('userId parameter is required', 400, 'MISSING_USER_ID');
      }

      // @ts-ignore
      // @ts-ignore
      const detail = await adminService.getUserDetail(userId);

      res.status(200).json({
        success: true,
        data: detail,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/users/:userId/status
   * Freeze / Suspend / Activate user account
   */
  public static async updateUserStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const { userId } = req.params;
      const { status, reason } = req.body || {};

      if (!status || !['ACTIVE', 'SUSPENDED', 'CLOSED'].includes(status)) {
        throw new AppError('Valid status (ACTIVE, SUSPENDED, CLOSED) is required', 400, 'INVALID_STATUS');
      }

      const user = await adminService.updateUserStatus({
      // @ts-ignore
        adminUserId: req.user.id,
      // @ts-ignore
        userId,
        status,
        reason: reason || 'Administrative action',
        ipAddress: (req.ip as string) as string,
        userAgent: (req.get('user-agent') as string) as string,
      });

      res.status(200).json({
        success: true,
        data: { user },
        message: `User account status updated to ${status}`,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * PATCH /api/v1/admin/users/:userId/role
   * Update user role (promote/demote)
   */
  public static async updateUserRole(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const { userId } = req.params;
      const { role, reason } = req.body || {};

      if (!role || !['USER', 'ADMIN', 'SYSTEM_BOT'].includes(role)) {
        throw new AppError('Valid role (USER, ADMIN, SYSTEM_BOT) is required', 400, 'INVALID_ROLE');
      }

      // @ts-ignore
      const user = await adminService.updateUserRole({
        adminUserId: req.user.id,
      // @ts-ignore
        userId,
        role,
        reason: reason || 'Administrative role update',
        ipAddress: (req.ip as string) as string,
        userAgent: (req.get('user-agent') as string) as string,
      });

      res.status(200).json({
        success: true,
        data: { user },
        message: `User role updated to ${role}`,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/audit-logs
   * Query immutable admin audit log records
   */
  public static async getAuditLogs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const adminUserId = req.query.adminUserId as string | undefined;
      const targetUserId = req.query.targetUserId as string | undefined;
      const action = req.query.action as string | undefined;
      const page = req.query.page ? parseInt(req.query.page as string, 10) : 1;
      const pageSize = req.query.pageSize ? parseInt(req.query.pageSize as string, 10) : 20;

      const result = await auditService.getLogs({
        adminUserId,
        targetUserId,
        action,
        page,
        pageSize,
      });

      res.status(200).json({
        success: true,
        data: result,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/metrics
   * Internal/Admin Telemetry snapshot in JSON format
   */
  public static async getMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { telemetryService } = await import('../services/system/telemetry.service');
      const metrics = await telemetryService.getMetricsJSON();
      res.status(200).json({
        success: true,
        data: metrics,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/metrics/prometheus
   * Internal/Admin Telemetry export in Prometheus exposition format
   */
  public static async getPrometheusMetrics(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { telemetryService } = await import('../services/system/telemetry.service');
      const text = await telemetryService.getPrometheusFormat();
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.status(200).send(text);
    } catch (err) {
      next(err);
    }
  }

  public static async getPendingWithdrawals(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { withdrawalService } = await import('../services/wallet/withdrawal.service');
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
      const withdrawals = await withdrawalService.getWithdrawalsPendingReview(limit);
      res.status(200).json({ success: true, data: withdrawals });
    } catch (err) {
      next(err);
    }
  }

  public static async approveWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { withdrawalService } = await import('../services/wallet/withdrawal.service');
      const withdrawalId = req.params.id as string;
      const adminId = req.user!.id;
      const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;

      // Audit is recorded INSIDE the service method's transaction for atomicity.
      await withdrawalService.approveWithdrawalAdmin(withdrawalId, adminId, reason, {
        adminUserId: adminId,
        action: 'APPROVE_WITHDRAWAL',
        targetResourceType: 'WITHDRAWAL',
        targetResourceId: withdrawalId,
        previousState: { crypto_status: 'PENDING_REVIEW' },
        newState: { crypto_status: 'APPROVED' },
        reason: reason || 'Administrative approval'
      });

      res.status(200).json({ success: true, message: 'Withdrawal approved successfully' });
    } catch (err) {
      next(err);
    }
  }

  public static async rejectWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { withdrawalService } = await import('../services/wallet/withdrawal.service');
      const withdrawalId = req.params.id as string;
      const adminId = req.user!.id;
      const reason = typeof req.body.reason === 'string' ? req.body.reason : '';

      if (!reason) {
        throw new AppError('Rejection reason is required', 400, 'MISSING_REASON');
      }

      // Audit is recorded INSIDE the service method's transaction for atomicity.
      await withdrawalService.rejectWithdrawalAdmin(withdrawalId, adminId, reason, {
        adminUserId: adminId,
        action: 'REJECT_WITHDRAWAL',
        targetResourceType: 'WITHDRAWAL',
        targetResourceId: withdrawalId,
        previousState: { crypto_status: 'PENDING_REVIEW' },
        newState: { crypto_status: 'CANCELLED' },
        reason: reason
      });

      res.status(200).json({ success: true, message: 'Withdrawal rejected successfully' });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/withdrawals/:id/resolve
   * Evidence-based resolution of UNKNOWN withdrawals (P0-3).
   * Body: { directive: 'FAILED' | 'COMPLETED', reason?: string }
   */
  public static async resolveWithdrawal(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { withdrawalService } = await import('../services/wallet/withdrawal.service');
      const withdrawalId = req.params.id as string;
      const adminId = req.user!.id;
      const directive = req.body.directive as string;
      const reason = typeof req.body.reason === 'string' ? req.body.reason : undefined;

      if (directive !== 'FAILED' && directive !== 'COMPLETED') {
        throw new AppError('directive must be either FAILED or COMPLETED', 400, 'INVALID_DIRECTIVE');
      }

      // Audit is recorded INSIDE the service method's transaction for atomicity.
      await withdrawalService.resolveWithdrawalAdmin(withdrawalId, adminId, directive, {
        adminUserId: adminId,
        action: 'RESOLVE_WITHDRAWAL',
        targetResourceType: 'WITHDRAWAL',
        targetResourceId: withdrawalId,
        previousState: { crypto_status: 'UNKNOWN' },
        newState: { crypto_status: directive },
        reason: reason || `Administrative UNKNOWN resolution -> ${directive}`
      });

      res.status(200).json({ success: true, message: `Withdrawal resolved as ${directive}` });
    } catch (err) {
      next(err);
    }
  }
}

