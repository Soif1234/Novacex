import { Request, Response, NextFunction } from 'express';
import { authService, SafeUser } from '../services/auth/auth.service';
import { sessionService } from '../services/auth/session.service';
import { UserRole } from '../models/user.model';
import { AppError } from './errorHandler';
import { logger } from '../config/logger';

declare global {
  namespace Express {
    interface Request {
      user?: SafeUser;
      accounts?: Array<{ id: string; type: string }>;
      sessionToken?: string;
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
 * Rate Limiter for Authentication Endpoints (Sliding window memory counter)
 */
const rateLimitMap = new Map<string, { count: number; resetAt: number }>();

export function authRateLimiter(maxRequests = 20, windowMs = 60000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.ip || req.socket.remoteAddress || 'unknown-ip';
    const now = Date.now();

    const record = rateLimitMap.get(key);
    if (!record || now > record.resetAt) {
      rateLimitMap.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }

    record.count++;
    if (record.count > maxRequests) {
      logger.warn('Auth Rate limit exceeded', { ip: key, count: record.count });
      return next(new AppError('Too many authentication attempts. Please wait a moment.', 429, 'RATE_LIMIT_EXCEEDED'));
    }

    next();
  };
}
