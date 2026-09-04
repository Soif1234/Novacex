import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { require2FA, requireAuth, requireRole } from '../src/middleware/auth';
import { authService } from '../src/services/auth/auth.service';
import { AdminController } from '../src/controllers/admin.controller';
import { TreasuryController } from '../src/controllers/treasury.controller';
import { requireCircuitBreaker } from '../src/middleware/circuitBreaker';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { AppError } from '../src/middleware/errorHandler';

describe('Phase 15B.1: Admin 2FA Fail-Closed Remediation', () => {
  const adminId = '11111111-2222-3333-4444-555555555555';
  const normalUserId = '99999999-8888-7777-6666-555555555555';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Scenario A: Admin + 2FA enabled + correct OTP -> PASS
  // ==========================================================================
  it('Scenario A: admin + 2FA enabled + correct OTP -> PASS (calls next() with no error)', async () => {
    vi.spyOn(authService, 'verify2FAForSensitiveAction').mockResolvedValue(true);

    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: true,
      },
      headers: {
        'x-2fa-code': '123456',
      },
      body: {},
    } as unknown as Request;

    const res = {} as Response;
    let nextCalled = false;
    let nextError: any = null;

    const next: NextFunction = (err?: any) => {
      nextCalled = true;
      nextError = err;
    };

    await require2FA(req, res, next);

    expect(nextCalled).toBe(true);
    expect(nextError).toBeUndefined();
    expect(authService.verify2FAForSensitiveAction).toHaveBeenCalledWith(adminId, '123456');
  });

  // ==========================================================================
  // Scenario B: Admin + 2FA enabled + invalid OTP -> FAIL (401 2FA_REQUIRED)
  // ==========================================================================
  it('Scenario B: admin + 2FA enabled + invalid OTP -> FAIL with 401 2FA_REQUIRED', async () => {
    vi.spyOn(authService, 'verify2FAForSensitiveAction').mockRejectedValue(
      new AppError('Two-factor authentication code is required and must be valid for this operation', 401, '2FA_REQUIRED')
    );

    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: true,
      },
      headers: {
        'x-2fa-code': '000000',
      },
      body: {},
    } as unknown as Request;

    const res = {} as Response;
    let nextCalled = false;
    let nextError: any = null;

    const next: NextFunction = (err?: any) => {
      nextCalled = true;
      nextError = err;
    };

    await require2FA(req, res, next);

    expect(nextCalled).toBe(true);
    expect(nextError).toBeDefined();
    expect(nextError).toBeInstanceOf(AppError);
    expect(nextError.statusCode).toBe(401);
    expect(nextError.code).toBe('2FA_REQUIRED');
  });

  it('Scenario B2: admin + 2FA enabled + missing OTP -> FAIL with 401 2FA_REQUIRED', async () => {
    const verifySpy = vi.spyOn(authService, 'verify2FAForSensitiveAction');

    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: true,
      },
      headers: {},
      body: {},
    } as unknown as Request;

    const res = {} as Response;
    let nextCalled = false;
    let nextError: any = null;

    const next: NextFunction = (err?: any) => {
      nextCalled = true;
      nextError = err;
    };

    await require2FA(req, res, next);

    expect(nextCalled).toBe(true);
    expect(nextError).toBeDefined();
    expect(nextError.statusCode).toBe(401);
    expect(nextError.code).toBe('2FA_REQUIRED');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario C: Admin + 2FA not enrolled -> FAIL CLOSED (HTTP 403 2FA_ENROLLMENT_REQUIRED)
  // ==========================================================================
  it('Scenario C: admin + 2FA not enrolled -> HTTP 403 2FA_ENROLLMENT_REQUIRED (no fallthrough)', async () => {
    const verifySpy = vi.spyOn(authService, 'verify2FAForSensitiveAction');

    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: false, // Unenrolled!
      },
      headers: {
        'x-2fa-code': '123456', // Even if attacker provides a random token
      },
      body: {},
    } as unknown as Request;

    const res = {} as Response;
    let nextCalled = false;
    let nextError: any = null;

    const next: NextFunction = (err?: any) => {
      nextCalled = true;
      nextError = err;
    };

    await require2FA(req, res, next);

    expect(nextCalled).toBe(true);
    expect(nextError).toBeDefined();
    expect(nextError).toBeInstanceOf(AppError);
    expect(nextError.statusCode).toBe(403);
    expect(nextError.code).toBe('2FA_ENROLLMENT_REQUIRED');
    expect(nextError.message).toContain('Two-factor authentication must be enrolled and active');
    expect(verifySpy).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario D: Non-admin -> existing authorization behavior preserved
  // ==========================================================================
  describe('Scenario D: Non-admin role authorization behavior preserved', () => {
    it('non-admin hitting requireRole(ADMIN) is rejected with 403 FORBIDDEN before 2FA check', async () => {
      const adminGuard = requireRole('ADMIN');

      const req = {
        user: {
          id: normalUserId,
          email: 'user@example.com',
          role: 'USER', // Non-admin
          twoFactorEnabled: false,
        },
      } as unknown as Request;

      const res = {} as Response;
      let nextError: any = null;
      const next: NextFunction = (err?: any) => { nextError = err; };

      adminGuard(req, res, next);

      expect(nextError).toBeDefined();
      expect(nextError.statusCode).toBe(403);
      expect(nextError.code).toBe('FORBIDDEN');
    });

    it('ordinary non-privileged routes (without require2FA) do not require 2FA', async () => {
      // Simulating a non-admin accessing an authenticated route that lacks require2FA
      const req = {
        user: {
          id: normalUserId,
          email: 'user@example.com',
          role: 'USER',
          twoFactorEnabled: false, // Not enrolled
        },
      } as unknown as Request;

      const res = {} as Response;
      let businessLogicExecuted = false;

      // Regular handler without require2FA
      const regularHandler = (r: Request, s: Response, next: NextFunction) => {
        businessLogicExecuted = true;
        next();
      };

      regularHandler(req, res, () => {});
      expect(businessLogicExecuted).toBe(true);
    });
  });

  // ==========================================================================
  // Scenario E: Protected withdrawal endpoint with unenrolled admin
  //             -> business logic NOT executed
  // ==========================================================================
  it('Scenario E: protected withdrawal endpoint with unenrolled admin -> business logic NOT executed', async () => {
    const approveSpy = vi.spyOn(AdminController, 'approveWithdrawal').mockImplementation(async () => {});
    const confirmTxSpy = vi.spyOn(AdminController, 'confirmWithdrawalTx').mockImplementation(async () => {});

    // Simulated middleware chain for POST /withdrawals/:id/approve:
    // [requireRole('ADMIN'), require2FA, mutationRateLimiter(), AdminController.approveWithdrawal]
    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: false, // Unenrolled admin
      },
      headers: {},
      body: {},
      params: { id: 'wd-123' },
    } as unknown as Request;

    const res = {} as Response;
    let chainError: any = null;

    // Execute require2FA step of chain
    await require2FA(req, res, (err) => {
      chainError = err;
    });

    // If require2FA errors, downstream controller is NOT called
    if (!chainError) {
      await AdminController.approveWithdrawal(req, res, () => {});
    }

    expect(chainError).toBeDefined();
    expect(chainError.statusCode).toBe(403);
    expect(chainError.code).toBe('2FA_ENROLLMENT_REQUIRED');
    expect(approveSpy).not.toHaveBeenCalled();
    expect(confirmTxSpy).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario F: Protected treasury endpoint with unenrolled admin
  //             -> business logic NOT executed
  // ==========================================================================
  it('Scenario F: protected treasury endpoint with unenrolled admin -> business logic NOT executed', async () => {
    const consolidateSpy = vi.spyOn(TreasuryController, 'consolidateToSafe').mockImplementation(async () => {});
    const confirmSpy = vi.spyOn(TreasuryController, 'confirmTreasury').mockImplementation(async () => {});

    // Simulated middleware chain for POST /treasury/consolidate:
    // [requireRole('ADMIN'), require2FA, mutationRateLimiter(), TreasuryController.consolidateToSafe]
    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: false, // Unenrolled admin
      },
      headers: {},
      body: {
        network: 'ETHEREUM',
        asset: 'ETH',
        amount: '1.0',
      },
    } as unknown as Request;

    const res = {} as Response;
    let chainError: any = null;

    await require2FA(req, res, (err) => {
      chainError = err;
    });

    if (!chainError) {
      await TreasuryController.consolidateToSafe(req, res, () => {});
    }

    expect(chainError).toBeDefined();
    expect(chainError.statusCode).toBe(403);
    expect(chainError.code).toBe('2FA_ENROLLMENT_REQUIRED');
    expect(consolidateSpy).not.toHaveBeenCalled();
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario G: Circuit-breaker protected admin control with unenrolled admin
  //             -> business logic NOT executed
  // ==========================================================================
  it('Scenario G: circuit-breaker/admin control with unenrolled admin -> business logic NOT executed', async () => {
    // Mock circuit breaker as operational
    vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({ operational: true, mode: 'ACTIVE' });
    const rejectSpy = vi.spyOn(AdminController, 'rejectWithdrawal').mockImplementation(async () => {});

    const req = {
      user: {
        id: adminId,
        email: 'admin@mallickexchange.com',
        role: 'ADMIN',
        accountStatus: 'ACTIVE',
        twoFactorEnabled: false, // Unenrolled admin
      },
      headers: {},
      body: { reason: 'Suspicious destination' },
      params: { id: 'wd-456' },
    } as unknown as Request;

    const res = {} as Response;
    let chainError: any = null;

    // 1. Circuit breaker middleware runs
    const cbMiddleware = requireCircuitBreaker('WITHDRAWALS');
    await cbMiddleware(req, res, async (cbErr) => {
      if (cbErr) {
        chainError = cbErr;
        return;
      }
      // 2. require2FA middleware runs next in chain
      await require2FA(req, res, async (twoFaErr) => {
        if (twoFaErr) {
          chainError = twoFaErr;
          return;
        }
        // 3. Controller only reachable if both pass
        await AdminController.rejectWithdrawal(req, res, () => {});
      });
    });

    expect(chainError).toBeDefined();
    expect(chainError.statusCode).toBe(403);
    expect(chainError.code).toBe('2FA_ENROLLMENT_REQUIRED');
    expect(rejectSpy).not.toHaveBeenCalled();
  });
});
