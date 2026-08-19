import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth/auth.service';
import { sessionService } from '../services/auth/session.service';
import { extractSessionToken } from '../middleware/auth';
import { env } from '../config/env';

export class AuthController {
  public static async signup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password, username, displayName } = req.body;
      const result = await authService.signup({ email, password, username, displayName });

      res.status(201).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  public static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password } = req.body;
      const ipAddress = req.ip || req.socket.remoteAddress;
      const userAgent = req.headers['user-agent'];

      const result = await authService.login({ email, password, ipAddress, userAgent });

      // Set secure HttpOnly session cookie
      const isProduction = env.NODE_ENV === 'production';
      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? ('strict' as const) : ('lax' as const),
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/'
      };

      // Set both standard cookie and Set-Cookie header for compatibility
      res.cookie('mallick_session', result.sessionToken, cookieOptions);
      res.setHeader('Set-Cookie', `mallick_session=${result.sessionToken}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=${isProduction ? 'Strict' : 'Lax'}${isProduction ? '; Secure' : ''}`);

      res.status(200).json({
        success: true,
        data: {
          user: result.user,
          accounts: result.user.accounts
        }
      });
    } catch (err) {
      next(err);
    }
  }

  public static async logout(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const token = extractSessionToken(req);
      if (token) {
        await sessionService.revokeSession(token);
      }

      // Clear session cookie idempotently
      res.clearCookie('mallick_session', { path: '/' });
      res.setHeader('Set-Cookie', 'mallick_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');

      res.status(200).json({
        success: true,
        message: 'Logged out successfully'
      });
    } catch (err) {
      next(err);
    }
  }

  public static async getMe(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      res.status(200).json({
        success: true,
        data: {
          user: req.user,
          accounts: req.accounts
        }
      });
    } catch (err) {
      next(err);
    }
  }
}
