import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { UserEntity, UserProfileEntity, UserAuthCredentialsEntity, UserRole } from '../../models/user.model';
import { AccountEntity } from '../../models/account.model';
import { normalizeEmail, validateEmail, validatePasswordStrength, hashPassword, verifyPassword } from './password';
import { sessionService, SessionService } from './session.service';
import { totpService, TotpService, TotpSetupResult } from './totp.service';
import { AppError } from '../../middleware/errorHandler';
import { logger } from '../../config/logger';

export interface SignupDto {
  email: string;
  password: string;
  username?: string;
  displayName?: string;
}

export interface LoginDto {
  email: string;
  password: string;
  twoFactorToken?: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface LoginResult {
  user?: SafeUser;
  sessionToken?: string;
  requires2FA?: boolean;
  tempToken?: string;
}

export interface SafeUser {
  id: string;
  email: string;
  role: UserRole;
  accountStatus: string;
  twoFactorEnabled?: boolean;
  profile: {
    username: string;
    displayName: string;
    avatarUrl?: string;
  };
  accounts: Array<{
    id: string;
    type: string;
  }>;
  createdAt: Date;
}

export class AuthService {
  private temp2faTokens: Map<string, { userId: string; email: string; expiresAt: number }> = new Map();

  constructor(
    private database: IDatabaseConnection = db,
    private sessions: SessionService = sessionService,
    private totp: TotpService = totpService
  ) {}

  public async signup(dto: SignupDto): Promise<{ user: SafeUser }> {
    // 1. Validate Email
    if (!validateEmail(dto.email)) {
      throw new AppError('Invalid email format', 400, 'INVALID_EMAIL');
    }
    const cleanEmail = normalizeEmail(dto.email);

    // 2. Validate Password Strength
    const passwordValidation = validatePasswordStrength(dto.password);
    if (!passwordValidation.valid) {
      throw new AppError(passwordValidation.errors.join('; '), 400, 'WEAK_PASSWORD', {
        errors: passwordValidation.errors
      });
    }

    // 3. Check for Duplicate Email
    const existingUser = await this.database.query<UserEntity>(
      'SELECT id FROM users WHERE email = $1',
      [cleanEmail]
    );

    if (existingUser.rows.length > 0) {
      throw new AppError('An account with this email address already exists', 409, 'EMAIL_EXISTS');
    }

    // 4. Hash password with Argon2id
    const passwordHash = await hashPassword(dto.password);

    // 5. Generate deterministic defaults for profile
    const namePrefix = cleanEmail.split('@')[0] || 'trader';
    const username = dto.username?.trim() || namePrefix.replace(/[^a-zA-Z0-9_]/g, '') + '_' + crypto.randomBytes(3).toString('hex');
    const displayName = dto.displayName?.trim() || namePrefix;

    const userId = crypto.randomUUID();

    // 6. Execute atomic transaction for user, profile, credentials, and accounts
    const created = await this.database.transaction(async (txClient) => {
      // A. Create User (Enforce USER role strictly; reject public admin creation)
      await txClient.query(
        'INSERT INTO users (id, email, role, account_status) VALUES ($1, $2, $3, $4)',
        [userId, cleanEmail, 'USER', 'ACTIVE']
      );

      // B. Create Profile
      await txClient.query(
        'INSERT INTO user_profiles (user_id, username, display_name, avatar_url) VALUES ($1, $2, $3, $4)',
        [userId, username, displayName, null]
      );

      // C. Create Auth Credentials
      await txClient.query(
        'INSERT INTO user_auth_credentials (user_id, password_hash, two_factor_enabled) VALUES ($1, $2, FALSE)',
        [userId, passwordHash]
      );

      // D. Create Accounts (SPOT, FUTURES, FUNDING)
      const spotAccId = crypto.randomUUID();
      const futuresAccId = crypto.randomUUID();
      const fundingAccId = crypto.randomUUID();

      await txClient.query(
        'INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)',
        [spotAccId, userId, 'SPOT']
      );
      await txClient.query(
        'INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)',
        [futuresAccId, userId, 'FUTURES']
      );
      await txClient.query(
        'INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)',
        [fundingAccId, userId, 'FUNDING']
      );

      return {
        userId,
        email: cleanEmail,
        role: 'USER' as UserRole,
        username,
        displayName,
        accounts: [
          { id: spotAccId, type: 'SPOT' },
          { id: futuresAccId, type: 'FUTURES' },
          { id: fundingAccId, type: 'FUNDING' }
        ]
      };
    });

    logger.info('Successfully registered new user', { userId, email: cleanEmail });

    return {
      user: {
        id: created.userId,
        email: created.email,
        role: created.role,
        accountStatus: 'ACTIVE',
        twoFactorEnabled: false,
        profile: {
          username: created.username,
          displayName: created.displayName
        },
        accounts: created.accounts,
        createdAt: new Date()
      }
    };
  }

  public async login(dto: LoginDto): Promise<LoginResult> {
    if (!dto.email || !dto.password) {
      throw new AppError('Email and password are required', 400, 'INVALID_INPUT');
    }

    const cleanEmail = normalizeEmail(dto.email);

    // 1. Fetch user by email
    const userRes = await this.database.query<UserEntity>(
      'SELECT id, email, role, account_status AS "accountStatus", created_at AS "createdAt" FROM users WHERE email = $1',
      [cleanEmail]
    );
    const user = userRes.rows[0];

    // Protect against timing attacks if user does not exist
    if (!user) {
      await verifyPassword('dummy_password_for_timing_safety', '$argon2id$v=19$m=65536,t=3,p=1$abcdef$123456');
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    if (user.accountStatus === 'SUSPENDED' || user.accountStatus === 'CLOSED') {
      throw new AppError('Your account has been suspended. Please contact support.', 403, 'ACCOUNT_SUSPENDED');
    }

    // 2. Fetch credentials
    const credsRes = await this.database.query<UserAuthCredentialsEntity>(
      'SELECT password_hash AS "passwordHash", two_factor_secret AS "twoFactorSecret", two_factor_enabled AS "twoFactorEnabled", failed_login_attempts AS "failedLoginAttempts", locked_until AS "lockedUntil" FROM user_auth_credentials WHERE user_id = $1',
      [user.id]
    );
    const creds: any = credsRes.rows[0];
    const passwordHash = creds?.passwordHash || creds?.password_hash;
    const twoFactorEnabled = creds?.twoFactorEnabled ?? creds?.two_factor_enabled ?? false;
    const twoFactorSecret = creds?.twoFactorSecret || creds?.two_factor_secret;

    if (!creds || !passwordHash) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // 3. Verify password
    const isMatch = await verifyPassword(dto.password, passwordHash);
    if (!isMatch) {
      logger.warn('Failed login attempt for user', { userId: user.id, email: cleanEmail });
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // 4. If 2FA is enabled: verify token if provided, or return 2FA challenge
    if (twoFactorEnabled && twoFactorSecret) {
      if (dto.twoFactorToken) {
        const isValid = this.totp.verifyToken(twoFactorSecret, dto.twoFactorToken);
        if (!isValid) {
          throw new AppError('Invalid Two-Factor Authentication code', 401, 'INVALID_2FA_TOKEN');
        }
      } else {
        // Return 2FA Challenge
        const tempToken = crypto.randomBytes(32).toString('hex');
        this.cleanExpiredTempTokens();
        this.temp2faTokens.set(tempToken, {
          userId: user.id,
          email: cleanEmail,
          expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
        });

        return {
          requires2FA: true,
          tempToken,
        };
      }
    }

    // 5. Create Session
    const { sessionToken } = await this.sessions.createSession(
      user.id,
      dto.ipAddress,
      dto.userAgent
    );

    // 6. Fetch Profile & Accounts
    const safeUser = await this.getUserById(user.id);

    logger.info('User successfully authenticated', { userId: user.id, role: user.role });

    return {
      sessionToken,
      user: safeUser!,
    };
  }

  /**
   * Complete 2FA login challenge with temporary token
   */
  public async verify2FALogin(
    tempToken: string,
    token: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<{ user: SafeUser; sessionToken: string }> {
    this.cleanExpiredTempTokens();
    const entry = this.temp2faTokens.get(tempToken);
    if (!entry || entry.expiresAt <= Date.now()) {
      throw new AppError('Two-factor login session expired or invalid. Please log in again.', 401, 'EXPIRED_2FA_SESSION');
    }

    const credsRes = await this.database.query<any>(
      'SELECT two_factor_secret AS "twoFactorSecret", two_factor_enabled AS "twoFactorEnabled" FROM user_auth_credentials WHERE user_id = $1',
      [entry.userId]
    );
    const creds = credsRes.rows[0];
    const secret = creds?.twoFactorSecret || creds?.two_factor_secret;

    if (!secret || !this.totp.verifyToken(secret, token)) {
      throw new AppError('Invalid Two-Factor Authentication code', 401, 'INVALID_2FA_TOKEN');
    }

    this.temp2faTokens.delete(tempToken);

    const { sessionToken } = await this.sessions.createSession(entry.userId, ipAddress, userAgent);
    const safeUser = await this.getUserById(entry.userId);

    logger.info('User completed 2FA login', { userId: entry.userId });

    return {
      sessionToken,
      user: safeUser!,
    };
  }

  /**
   * Setup 2FA: generates secret and otpauth URI (not enabled until verified)
   */
  public async setup2FA(userId: string): Promise<TotpSetupResult> {
    const userRes = await this.database.query<any>('SELECT email FROM users WHERE id = $1', [userId]);
    const user = userRes.rows[0];
    if (!user) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const setup = this.totp.generateSecret(user.email);

    await this.database.query(
      'UPDATE user_auth_credentials SET two_factor_secret = $1, updated_at = NOW() WHERE user_id = $2',
      [setup.secret, userId]
    );

    return setup;
  }

  /**
   * Enable 2FA: verifies code against pending secret before activating
   */
  public async enable2FA(userId: string, token: string): Promise<boolean> {
    const credsRes = await this.database.query<any>(
      'SELECT two_factor_secret AS "twoFactorSecret" FROM user_auth_credentials WHERE user_id = $1',
      [userId]
    );
    const secret = credsRes.rows[0]?.twoFactorSecret || credsRes.rows[0]?.two_factor_secret;
    if (!secret) {
      throw new AppError('2FA setup not initiated. Please request setup first.', 400, 'NO_2FA_SECRET');
    }

    const isValid = this.totp.verifyToken(secret, token);
    if (!isValid) {
      throw new AppError('Invalid Two-Factor Authentication code', 400, 'INVALID_2FA_TOKEN');
    }

    await this.database.query(
      'UPDATE user_auth_credentials SET two_factor_enabled = TRUE, updated_at = NOW() WHERE user_id = $1',
      [userId]
    );

    logger.info('2FA successfully enabled for user', { userId });
    return true;
  }

  /**
   * Disable 2FA: requires password verification and valid 2FA token
   */
  public async disable2FA(userId: string, password: string, token: string): Promise<boolean> {
    const credsRes = await this.database.query<any>(
      'SELECT password_hash AS "passwordHash", two_factor_secret AS "twoFactorSecret", two_factor_enabled AS "twoFactorEnabled" FROM user_auth_credentials WHERE user_id = $1',
      [userId]
    );
    const creds = credsRes.rows[0];
    if (!creds) {
      throw new AppError('User not found', 404, 'USER_NOT_FOUND');
    }

    const passwordHash = creds.passwordHash || creds.password_hash;
    const secret = creds.twoFactorSecret || creds.two_factor_secret;
    const isEnabled = creds.twoFactorEnabled ?? creds.two_factor_enabled;

    if (!isEnabled || !secret) {
      throw new AppError('Two-factor authentication is not currently enabled', 400, '2FA_NOT_ENABLED');
    }

    const passwordMatch = await verifyPassword(password, passwordHash);
    if (!passwordMatch) {
      throw new AppError('Invalid password', 401, 'INVALID_PASSWORD');
    }

    const tokenMatch = this.totp.verifyToken(secret, token);
    if (!tokenMatch) {
      throw new AppError('Invalid Two-Factor Authentication code', 401, 'INVALID_2FA_TOKEN');
    }

    await this.database.query(
      'UPDATE user_auth_credentials SET two_factor_enabled = FALSE, two_factor_secret = NULL, updated_at = NOW() WHERE user_id = $1',
      [userId]
    );

    logger.info('2FA successfully disabled for user', { userId });
    return true;
  }

  /**
   * Verify 2FA token for sensitive operations (e.g., withdrawals, API key creation)
   */
  public async verify2FAForSensitiveAction(userId: string, token?: string): Promise<boolean> {
    const credsRes = await this.database.query<any>(
      'SELECT two_factor_secret AS "twoFactorSecret", two_factor_enabled AS "twoFactorEnabled" FROM user_auth_credentials WHERE user_id = $1',
      [userId]
    );
    const creds = credsRes.rows[0];
    const isEnabled = creds?.twoFactorEnabled ?? creds?.two_factor_enabled;
    const secret = creds?.twoFactorSecret || creds?.two_factor_secret;

    if (!isEnabled) {
      return true; // 2FA not required if not enabled
    }

    if (!token || !secret || !this.totp.verifyToken(secret, token)) {
      throw new AppError('Two-factor authentication code is required and must be valid for this operation', 401, '2FA_REQUIRED');
    }

    return true;
  }

  private cleanExpiredTempTokens(): void {
    const now = Date.now();
    for (const [token, data] of this.temp2faTokens.entries()) {
      if (data.expiresAt <= now) {
        this.temp2faTokens.delete(token);
      }
    }
  }

  public async getUserById(userId: string): Promise<SafeUser | null> {
    const userRes = await this.database.query<any>(
      'SELECT id, email, role, account_status AS "accountStatus", created_at AS "createdAt" FROM users WHERE id = $1',
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) return null;

    const [profileRes, accountsRes, credsRes] = await Promise.all([
      this.database.query<any>(
        'SELECT username, display_name AS "displayName", avatar_url AS "avatarUrl" FROM user_profiles WHERE user_id = $1',
        [user.id]
      ),
      this.database.query<any>(
        'SELECT id, type FROM accounts WHERE user_id = $1',
        [user.id]
      ),
      this.database.query<any>(
        'SELECT two_factor_enabled AS "twoFactorEnabled" FROM user_auth_credentials WHERE user_id = $1',
        [user.id]
      )
    ]);

    const profileRow = profileRes.rows[0];
    const profile = {
      username: profileRow?.username || user.email.split('@')[0],
      displayName: profileRow?.displayName || profileRow?.display_name || user.email.split('@')[0],
      avatarUrl: profileRow?.avatarUrl || profileRow?.avatar_url || undefined
    };

    const creds = credsRes.rows[0];
    const twoFactorEnabled = creds?.twoFactorEnabled ?? creds?.two_factor_enabled ?? false;

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      accountStatus: user.accountStatus || user.account_status || 'ACTIVE',
      twoFactorEnabled,
      profile,
      accounts: accountsRes.rows.map(a => ({ id: a.id, type: a.type })),
      createdAt: user.createdAt || user.created_at || new Date()
    };
  }

  public async getUserBySessionToken(rawToken: string): Promise<SafeUser | null> {
    const session = await this.sessions.validateSession(rawToken);
    if (!session) return null;
    return this.getUserById(session.userId);
  }
}

export const authService = new AuthService();
