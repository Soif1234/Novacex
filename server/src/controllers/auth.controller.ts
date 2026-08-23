import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth/auth.service';
import { sessionService } from '../services/auth/session.service';
import { apiKeyService } from '../services/auth/api-key.service';
import { extractSessionToken } from '../middleware/auth';
import { env } from '../config/env';

export class AuthController {
  public static async signup(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password, username, displayName } = req.body;
      const result = await authService.signup({ email, password, username, displayName });

      res.status(201).json({
        success: true,
        data: {
          user: result.user,
          accounts: result.user.accounts,
        }
      });
    } catch (err) {
      next(err);
    }
  }


  public static async login(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { email, password, twoFactorToken } = req.body;
      const ipAddress = (req.ip as string) || req.socket.remoteAddress;
      const userAgent = (req.headers['user-agent'] as string);

      const result = await authService.login({ email, password, twoFactorToken, ipAddress, userAgent });

      // If 2FA is required, return challenge response
      if (result.requires2FA) {
        res.status(200).json({
          success: true,
          requires2FA: true,
          twoFactorRequired: true,
          tempToken: result.tempToken,
          message: 'Two-factor authentication code required',
        });
        return;
      }


      // Set secure HttpOnly session cookie
      const isProduction = env.NODE_ENV === 'production';
      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? ('strict' as const) : ('lax' as const),
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        path: '/'
      };

      res.cookie('mallick_session', result.sessionToken!, cookieOptions);
      res.setHeader('Set-Cookie', `mallick_session=${result.sessionToken}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=${isProduction ? 'Strict' : 'Lax'}${isProduction ? '; Secure' : ''}`);

      res.status(200).json({
        success: true,
        data: {
          user: result.user,
          accounts: result.user!.accounts,
          sessionToken: result.sessionToken,
        }
      });
    } catch (err) {
      next(err);
    }
  }

  public static async verify2FALogin(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { tempToken, token, twoFactorToken } = req.body || {};
      const totpToken = token || twoFactorToken;
      const ipAddress = (req.ip as string) || req.socket.remoteAddress;
      const userAgent = (req.headers['user-agent'] as string);

      const result = await authService.verify2FALogin(tempToken, totpToken, ipAddress, userAgent);


      const isProduction = env.NODE_ENV === 'production';
      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? ('strict' as const) : ('lax' as const),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      };

      res.cookie('mallick_session', result.sessionToken, cookieOptions);
      res.setHeader('Set-Cookie', `mallick_session=${result.sessionToken}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=${isProduction ? 'Strict' : 'Lax'}${isProduction ? '; Secure' : ''}`);

      res.status(200).json({
        success: true,
        data: {
          user: result.user,
          accounts: result.user.accounts,
          sessionToken: result.sessionToken,
        }
      });
    } catch (err) {
      next(err);

    }
  }

  public static async demoSession(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      // Provision an isolated demo account with SERVER-generated random credentials.
      // Replaces the previous shared hardcoded-password demo login.
      const rand = crypto.randomBytes(16).toString('hex');
      const email = `demo_${rand}@demo.mallickexchange.com`;
      // 'Aa1!' prefix guarantees upper/lower/digit/special; body adds entropy.
      const password = `Aa1!${crypto.randomBytes(24).toString('base64url')}`;

      await authService.signup({ email, password, displayName: 'Demo Trader' });

      const ipAddress = (req.ip as string) || req.socket.remoteAddress;
      const userAgent = (req.headers['user-agent'] as string);
      const result = await authService.login({ email, password, ipAddress, userAgent });

      const isProduction = env.NODE_ENV === 'production';
      const cookieOptions = {
        httpOnly: true,
        secure: isProduction,
        sameSite: isProduction ? ('strict' as const) : ('lax' as const),
        maxAge: 7 * 24 * 60 * 60 * 1000,
        path: '/'
      };
      res.cookie('mallick_session', result.sessionToken!, cookieOptions);
      res.setHeader('Set-Cookie', `mallick_session=${result.sessionToken}; Path=/; Max-Age=${7 * 24 * 60 * 60}; HttpOnly; SameSite=${isProduction ? 'Strict' : 'Lax'}${isProduction ? '; Secure' : ''}`);

      res.status(201).json({
        success: true,
        data: {
          user: result.user,
          accounts: result.user!.accounts,
          sessionToken: result.sessionToken,
        }
      });
    } catch (err) {
      next(err);
    }
  }

  public static async setup2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const result = await authService.setup2FA(req.user!.id);
      res.status(200).json({
        success: true,
        data: result
      });
    } catch (err) {
      next(err);
    }
  }

  public static async enable2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { token } = req.body;
      await authService.enable2FA(req.user!.id, token);
      res.status(200).json({
        success: true,
        message: 'Two-factor authentication successfully enabled'
      });
    } catch (err) {
      next(err);
    }
  }

  public static async disable2FA(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { password, token } = req.body;
      await authService.disable2FA(req.user!.id, password, token);
      res.status(200).json({
        success: true,
        message: 'Two-factor authentication successfully disabled'
      });
    } catch (err) {
      next(err);
    }
  }

  public static async createApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { label, permissions, ipWhitelist, expiresAt, twoFactorToken } = req.body;

      // Enforce 2FA verification if enabled
      await authService.verify2FAForSensitiveAction(req.user!.id, twoFactorToken);

      const apiKey = await apiKeyService.createApiKey({
        userId: req.user!.id,
        label,
        permissions,
        ipWhitelist,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      res.status(201).json({
        success: true,
        data: apiKey,
        warning: 'Please save your secret key securely. It will never be shown again.',
      });
    } catch (err) {
      next(err);
    }
  }

  public static async listApiKeys(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const apiKeys = await apiKeyService.listApiKeys(req.user!.id);
      res.status(200).json({
        success: true,
        data: { apiKeys }
      });
    } catch (err) {
      next(err);
    }
  }

  public static async revokeApiKey(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { id } = req.params;
      // @ts-ignore
      // @ts-ignore
      const revoked = await apiKeyService.revokeApiKey(req.user!.id, id);
      if (!revoked) {
        res.status(404).json({
          success: false,
          error: { code: 'API_KEY_NOT_FOUND', message: 'API key not found or already revoked' }
        });
        return;
      }

      res.status(200).json({
        success: true,
        message: 'API key successfully revoked'
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
