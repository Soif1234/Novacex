import { Request, Response, NextFunction } from 'express';
import { reconciliationService } from '../services/compliance/reconciliation.service';
import { threatAlertService } from '../services/compliance/threat-alert.service';
import { AppError } from '../middleware/errorHandler';

export class ReconciliationController {
  /**
   * POST /api/v1/admin/reconciliation/run
   * Manually trigger exchange reconciliation sweep
   */
  public static async triggerReconciliation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const report = await reconciliationService.runReconciliation('ADMIN_MANUAL', req.user.id);
      res.status(200).json({
        success: true,
        data: report,
        message: `Reconciliation completed with status: ${report.status}`,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/reconciliation/reports
   * Query historical reconciliation reports
   */
  public static async getReports(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, page, pageSize } = req.query;
      const result = await reconciliationService.getReports({
        status: status as string,
        page: page ? parseInt(page as string, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
      });

      res.status(200).json({
        success: true,
        data: result.reports,
        pagination: {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/admin/reconciliation/alerts
   * Query active or historical threat alerts
   */
  public static async getAlerts(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { status, severity, category, page, pageSize } = req.query;
      const result = await threatAlertService.getAlerts({
        status: status as any,
        severity: severity as any,
        category: category as string,
        page: page ? parseInt(page as string, 10) : undefined,
        pageSize: pageSize ? parseInt(pageSize as string, 10) : undefined,
      });

      res.status(200).json({
        success: true,
        data: result.alerts,
        pagination: {
          total: result.total,
          page: result.page,
          pageSize: result.pageSize,
        },
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/reconciliation/alerts/:alertId/resolve
   * Resolve or acknowledge an active security threat alert
   */
  public static async resolveAlert(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const { alertId } = req.params;
      const { status, resolutionNotes } = req.body || {};

      if (!status || !['RESOLVED', 'IGNORED'].includes(status)) {
        throw new AppError('Status must be RESOLVED or IGNORED', 400, 'INVALID_STATUS');
      }

      if (!resolutionNotes || !resolutionNotes.trim()) {
        throw new AppError('Resolution notes are mandatory', 400, 'MISSING_RESOLUTION_NOTES');
      }

      const alert = await threatAlertService.resolveAlert(alertId, {
        adminUserId: req.user.id,
        status,
        resolutionNotes,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        success: true,
        data: alert,
        message: `Threat alert marked as ${status}`,
      });
    } catch (err) {
      next(err);
    }
  }
}
