import { Request, Response, NextFunction } from 'express';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';
import { SystemSubsystem } from '../models/system.model';

/**
 * Middleware to enforce operational circuit-breaker state before processing requests
 */
export function requireCircuitBreaker(subsystem: SystemSubsystem) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const check = await circuitBreakerService.isSubsystemOperational(subsystem);

      if (!check.operational) {
        res.status(503).json({
          success: false,
          error: {
            code: 'CIRCUIT_BREAKER_TRIGGERED',
            message: `${subsystem} is temporarily halted due to system circuit breaker (${check.mode})${
              check.reason ? `: ${check.reason}` : '.'
            }`,
          },
        });
        return;
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
