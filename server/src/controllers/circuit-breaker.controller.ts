import { Request, Response, NextFunction } from 'express';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';
import { AppError } from '../middleware/errorHandler';
import { CircuitBreakerMode } from '../models/system.model';

export class CircuitBreakerController {
  /**
   * GET /api/v1/admin/circuit-breaker/status
   * Full administrative circuit breaker state
   */
  public static async getAdminStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const state = await circuitBreakerService.getState();
      res.status(200).json({
        success: true,
        data: state,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/circuit-breaker/halt
   * Trigger emergency halt
   */
  public static async halt(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const {
        mode,
        reason,
        isSpotTradingEnabled,
        isFuturesTradingEnabled,
        isWithdrawalsEnabled,
        isDepositsEnabled,
      } = req.body || {};

      if (!mode || !['HALT_ALL', 'HALT_TRADING', 'HALT_WITHDRAWALS', 'CUSTOM'].includes(mode)) {
        throw new AppError('Valid halt mode (HALT_ALL, HALT_TRADING, HALT_WITHDRAWALS, CUSTOM) is required', 400, 'INVALID_MODE');
      }

      if (!reason || !reason.trim()) {
        throw new AppError('A valid reason is required to trigger a circuit breaker halt', 400, 'MISSING_REASON');
      }

      const state = await circuitBreakerService.halt({
        adminUserId: req.user.id,
        mode: mode as CircuitBreakerMode,
        reason,
        isSpotTradingEnabled,
        isFuturesTradingEnabled,
        isWithdrawalsEnabled,
        isDepositsEnabled,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        success: true,
        data: state,
        message: `System circuit breaker halt activated (${mode})`,
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * POST /api/v1/admin/circuit-breaker/resume
   * Resume normal operations or selected subsystems
   */
  public static async resume(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) {
        throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
      }

      const {
        reason,
        resumeAll,
        isSpotTradingEnabled,
        isFuturesTradingEnabled,
        isWithdrawalsEnabled,
        isDepositsEnabled,
      } = req.body || {};

      if (!reason || !reason.trim()) {
        throw new AppError('A valid reason is required to resume operations', 400, 'MISSING_REASON');
      }

      const state = await circuitBreakerService.resume({
        adminUserId: req.user.id,
        reason,
        resumeAll: resumeAll !== false,
        isSpotTradingEnabled,
        isFuturesTradingEnabled,
        isWithdrawalsEnabled,
        isDepositsEnabled,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      });

      res.status(200).json({
        success: true,
        data: state,
        message: 'System circuit breaker operations resumed',
      });
    } catch (err) {
      next(err);
    }
  }

  /**
   * GET /api/v1/health/circuit-breaker or public endpoint
   */
  public static async getPublicStatus(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const publicStatus = await circuitBreakerService.getPublicStatus();
      res.status(200).json({
        success: true,
        data: publicStatus,
      });
    } catch (err) {
      next(err);
    }
  }
}
