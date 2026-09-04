import { Request, Response, NextFunction } from 'express';
import { authService, SafeUser } from '../services/auth/auth.service';
import { sessionService } from '../services/auth/session.service';
import { apiKeyService } from '../services/auth/api-key.service';
import { UserRole } from '../models/user.model';
import { ApiKeyPermission } from '../models/api-key.model';
import { AppError } from './errorHandler';
import { logger } from '../config/logger';
import { redis } from '../config/redis';

declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
      accounts?: Array<{ id: string; type: string }>;
      sessionToken?: string;
      apiKeyId?: string;
      apiKeyPermissions?: ApiKeyPermission[];
    }
  }
}

/**
 * Extract session token from cookie, Authorization header, or custom header
 */
export function extractSessionToken(req: Request): string | null {
  // 1. Check Cookie header (parsed or raw header string)
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    const cookies = cookieHeader.split(';').map(c => c.trim());
    for (const cookie of cookies) {
      if (cookie.startsWith('mallick_session=')) {
        const val = cookie.substring('mallick_session='.length);
        if (val) return decodeURIComponent(val);
      }
    }
  }

  // 2. Check Authorization Bearer header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) return token;
  }

  // 3. Check X-Session-Token header
  const customHeader = req.headers['x-session-token'];
  if (typeof customHeader === 'string' && customHeader.trim().length > 0) {
    return customHeader.trim();
  }

  return null;
}

/**
 * Middleware enforcing active authentication session
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const token = extractSessionToken(req);

    if (!token) {
      logger.warn('requireAuth missing token', {
        headers: req.headers,
        url: req.originalUrl,
        method: req.method,
      });
      throw new AppError('Authentication required. Please log in.', 401, 'UNAUTHORIZED');
    }


    const session = await sessionService.validateSession(token);
    if (!session) {
      throw new AppError('Session expired or invalid. Please log in again.', 401, 'INVALID_SESSION');
    }

    const user = await authService.getUserById(session.userId);
    if (!user) {
      throw new AppError('User not found. Please log in again.', 401, 'USER_NOT_FOUND');
    }

    if (user.accountStatus === 'SUSPENDED' || user.accountStatus === 'CLOSED') {
      throw new AppError('Account is suspended. Access denied.', 403, 'ACCOUNT_SUSPENDED');
    }

    // Attach authenticated identity to request context
    req.user = user;
    req.accounts = user.accounts;
    req.sessionToken = token;

    next();
  } catch (err) {
    next(err);
  }
}

/**
 * Role-Based Access Control (RBAC) middleware
 */
export function requireRole(...allowedRoles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    if (!allowedRoles.includes(req.user.role)) {
      logger.warn('RBAC Access Denied', {
        userId: req.user.id,
        userRole: req.user.role,
        requiredRoles: allowedRoles,
        path: req.originalUrl
      });
      return next(new AppError('Access denied: Insufficient permissions', 403, 'FORBIDDEN'));
    }

    next();
  };
}

/**
 * Account ownership verification middleware
 */
export function requireAccountOwnership(paramName = 'accountId') {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user || !req.accounts) {
      return next(new AppError('Authentication required', 401, 'UNAUTHORIZED'));
    }

    // Resolve target account ID from route params, query, or body
    const targetAccountId = req.params[paramName] || req.query[paramName] || req.body?.[paramName];

    if (!targetAccountId || typeof targetAccountId !== 'string') {
      return next(new AppError(`Account identifier (${paramName}) is required`, 400, 'ACCOUNT_ID_REQUIRED'));
    }

    const isOwned = req.accounts.some(acc => acc.id === targetAccountId);
    if (!isOwned) {
      logger.warn('Account Ownership Violation Detected', {
        userId: req.user.id,
        attemptedAccountId: targetAccountId,
        ownedAccounts: req.accounts.map(a => a.id)
      });
      return next(new AppError('Access denied: You do not have permission to access this account', 403, 'ACCOUNT_ACCESS_DENIED'));
    }

    next();
  };
}

/**
 * Middleware requiring valid HMAC-SHA256 Signed API Key Authentication
 */
export function requireApiKeyAuth(requiredPermission?: ApiKeyPermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const keyId = (req.headers['x-api-key'] || req.headers['X-API-KEY']) as string;
      const timestampStr = (req.headers['x-api-timestamp'] || req.headers['X-API-TIMESTAMP']) as string;
      const nonce = (req.headers['x-api-nonce'] || req.headers['X-API-NONCE']) as string;
      const signature = (req.headers['x-api-signature'] || req.headers['X-API-SIGNATURE']) as string;

      if (!keyId || !timestampStr || !nonce || !signature) {
        throw new AppError('API key authentication headers missing (X-API-KEY, X-API-TIMESTAMP, X-API-NONCE, X-API-SIGNATURE)', 401, 'API_KEY_AUTH_REQUIRED');
      }

      const timestamp = parseInt(timestampStr, 10);
      if (isNaN(timestamp)) {
        throw new AppError('Invalid X-API-TIMESTAMP header', 400, 'INVALID_API_TIMESTAMP');
      }

      const clientIp = (req.ip || req.socket.remoteAddress || '').replace('::ffff:', '');
      const bodyString = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : '';

      const verification = await apiKeyService.verifySignedRequest({
        keyId,
        timestamp,
        nonce,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        bodyString,
        signature,
        clientIp,
        requiredPermission,
      });

      if (!verification.valid || !verification.userId) {
        throw new AppError(verification.error || 'API key authentication failed', 401, 'API_KEY_AUTH_FAILED');
      }

      const user = await authService.getUserById(verification.userId);
      if (!user) {
        throw new AppError('User associated with API key not found', 401, 'USER_NOT_FOUND');
      }

      if (user.accountStatus === 'SUSPENDED' || user.accountStatus === 'CLOSED') {
        throw new AppError('Account is suspended. API key access denied.', 403, 'ACCOUNT_SUSPENDED');
      }

      req.user = user;
      req.accounts = user.accounts;
      req.apiKeyId = keyId;

      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Flexible middleware allowing either Session Auth or Signed API Key Auth
 */
export function requireAuthOrApiKey(requiredPermission?: ApiKeyPermission) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const hasApiKeyHeader = Boolean(req.headers['x-api-key'] || req.headers['X-API-KEY']);
    if (hasApiKeyHeader) {
      return requireApiKeyAuth(requiredPermission)(req, res, next);
    }
    return requireAuth(req, res, next);
  };
}

/**
 * Middleware enforcing 2FA verification for sensitive operations.
 * Fails closed: if 2FA is not enrolled and active, access is denied (HTTP 403).
 */
export async function require2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    if (!req.user) {
      throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
    }

    if (!req.user.twoFactorEnabled) {
      throw new AppError(
        'Two-factor authentication must be enrolled and active for this operation',
        403,
        '2FA_ENROLLMENT_REQUIRED'
      );
    }

    const token = (req.headers['x-2fa-code'] || req.headers['X-2FA-CODE'] || req.body?.twoFactorCode || req.body?.twoFactorToken) as string;
    if (!token) {
      throw new AppError('Two-Factor Authentication code required (X-2FA-Code header)', 401, '2FA_REQUIRED');
    }

    await authService.verify2FAForSensitiveAction(req.user.id, token);
    next();
  } catch (err) {
    next(err);
  }
}

export { authRateLimiter } from './rateLimit';



