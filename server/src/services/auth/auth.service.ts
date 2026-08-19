import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { UserEntity, UserProfileEntity, UserAuthCredentialsEntity, UserRole } from '../../models/user.model';
import { AccountEntity } from '../../models/account.model';
import { normalizeEmail, validateEmail, validatePasswordStrength, hashPassword, verifyPassword } from './password';
import { sessionService, SessionService } from './session.service';
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
  ipAddress?: string;
  userAgent?: string;
}

export interface SafeUser {
  id: string;
  email: string;
  role: UserRole;
  accountStatus: string;
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
  constructor(
    private database: IDatabaseConnection = db,
    private sessions: SessionService = sessionService
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
        'INSERT INTO user_auth_credentials (user_id, password_hash) VALUES ($1, $2)',
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
        profile: {
          username: created.username,
          displayName: created.displayName
        },
        accounts: created.accounts,
        createdAt: new Date()
      }
    };
  }

  public async login(dto: LoginDto): Promise<{ user: SafeUser; sessionToken: string }> {
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
      'SELECT password_hash AS "passwordHash", failed_login_attempts AS "failedLoginAttempts", locked_until AS "lockedUntil" FROM user_auth_credentials WHERE user_id = $1',
      [user.id]
    );
    const creds: any = credsRes.rows[0];
    const passwordHash = creds?.passwordHash || creds?.password_hash;

    if (!creds || !passwordHash) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // 3. Verify Argon2id password
    const isMatch = await verifyPassword(dto.password, passwordHash);
    if (!isMatch) {
      logger.warn('Failed login attempt for user', { userId: user.id, email: cleanEmail });
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    // 4. Create Session
    const { sessionToken } = await this.sessions.createSession(
      user.id,
      dto.ipAddress,
      dto.userAgent
    );

    // 5. Fetch Profile & Accounts
    const [profileRes, accountsRes] = await Promise.all([
      this.database.query<any>(
        'SELECT username, display_name AS "displayName", avatar_url AS "avatarUrl" FROM user_profiles WHERE user_id = $1',
        [user.id]
      ),
      this.database.query<any>(
        'SELECT id, type FROM accounts WHERE user_id = $1',
        [user.id]
      )
    ]);

    const profileRow = profileRes.rows[0];
    const profile = {
      username: profileRow?.username || cleanEmail.split('@')[0],
      displayName: profileRow?.displayName || profileRow?.display_name || cleanEmail.split('@')[0],
      avatarUrl: profileRow?.avatarUrl || profileRow?.avatar_url || undefined
    };

    logger.info('User successfully authenticated', { userId: user.id, role: user.role });

    return {
      sessionToken,
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        accountStatus: user.accountStatus || (user as any).account_status || 'ACTIVE',
        profile,
        accounts: accountsRes.rows.map(a => ({ id: a.id, type: a.type })),
        createdAt: user.createdAt || (user as any).created_at || new Date()
      }
    };
  }

  public async getUserById(userId: string): Promise<SafeUser | null> {
    const userRes = await this.database.query<any>(
      'SELECT id, email, role, account_status AS "accountStatus", created_at AS "createdAt" FROM users WHERE id = $1',
      [userId]
    );
    const user = userRes.rows[0];
    if (!user) return null;

    const [profileRes, accountsRes] = await Promise.all([
      this.database.query<any>(
        'SELECT username, display_name AS "displayName", avatar_url AS "avatarUrl" FROM user_profiles WHERE user_id = $1',
        [user.id]
      ),
      this.database.query<any>(
        'SELECT id, type FROM accounts WHERE user_id = $1',
        [user.id]
      )
    ]);

    const profileRow = profileRes.rows[0];
    const profile = {
      username: profileRow?.username || user.email.split('@')[0],
      displayName: profileRow?.displayName || profileRow?.display_name || user.email.split('@')[0],
      avatarUrl: profileRow?.avatarUrl || profileRow?.avatar_url || undefined
    };

    return {
      id: user.id,
      email: user.email,
      role: user.role,
      accountStatus: user.accountStatus || user.account_status || 'ACTIVE',
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
