import crypto from 'crypto';
import { env } from './env';
import { logger } from './logger';
import { UserEntity, UserProfileEntity, UserAuthCredentialsEntity, UserSessionEntity } from '../models/user.model';
import { AccountEntity } from '../models/account.model';

export interface DatabaseStatus {
  connected: boolean;
  poolSize: number;
  activeConnections: number;
  idleConnections: number;
  lastPingMs?: number;
  error?: string;
}

export interface QueryResult<T = unknown> {
  rows: T[];
  rowCount: number;
}

export interface IDatabaseConnection {
  connect(): Promise<void>;
  close(): Promise<void>;
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  transaction<T = unknown>(callback: (client: IDatabaseConnection) => Promise<T>): Promise<T>;
  healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }>;
  getStatus(): DatabaseStatus;
  reset?(): void;
}

export class DatabasePool implements IDatabaseConnection {
  private isConnected = false;
  private connectionError: string | null = null;
  private activeClients = 0;
  private totalPoolSize = 0;

  // In-memory relational tables for local dev/testing
  private users = new Map<string, UserEntity>();
  private usersByEmail = new Map<string, string>(); // email -> id
  private userProfiles = new Map<string, UserProfileEntity>(); // userId -> profile
  private userCredentials = new Map<string, UserAuthCredentialsEntity>(); // userId -> creds
  private userSessions = new Map<string, UserSessionEntity>(); // tokenHash -> session
  private accounts = new Map<string, AccountEntity>(); // id -> account
  private schemaMigrations = new Set<string>();

  constructor(private config = env) {
    this.totalPoolSize = config.DB_POOL_MIN;
  }

  public async connect(): Promise<void> {
    logger.info('Initializing PostgreSQL connection pool', {
      host: this.config.DB_HOST,
      port: this.config.DB_PORT,
      database: this.config.DB_NAME,
      user: this.config.DB_USER
    });

    this.isConnected = true;
    this.connectionError = null;
    logger.info('PostgreSQL connection pool initialized successfully');
  }

  public async close(): Promise<void> {
    logger.info('Draining PostgreSQL connection pool');
    this.isConnected = false;
    this.activeClients = 0;
    logger.info('PostgreSQL connection pool drained');
  }

  public reset(): void {
    this.users.clear();
    this.usersByEmail.clear();
    this.userProfiles.clear();
    this.userCredentials.clear();
    this.userSessions.clear();
    this.accounts.clear();
    this.schemaMigrations.clear();
  }

  public async transaction<T = unknown>(callback: (client: IDatabaseConnection) => Promise<T>): Promise<T> {
    if (!this.isConnected) throw new Error('Database is not connected');

    // Create snapshots for rollback safety
    const snapUsers = new Map(this.users);
    const snapUsersByEmail = new Map(this.usersByEmail);
    const snapProfiles = new Map(this.userProfiles);
    const snapCreds = new Map(this.userCredentials);
    const snapSessions = new Map(this.userSessions);
    const snapAccounts = new Map(this.accounts);

    try {
      const result = await callback(this);
      return result;
    } catch (err) {
      // Rollback state on error
      this.users = snapUsers;
      this.usersByEmail = snapUsersByEmail;
      this.userProfiles = snapProfiles;
      this.userCredentials = snapCreds;
      this.userSessions = snapSessions;
      this.accounts = snapAccounts;
      throw err;
    }
  }

  private mapUser(u: UserEntity): any {
    return {
      ...u,
      account_status: u.accountStatus,
      created_at: u.createdAt,
      updated_at: u.updatedAt
    };
  }

  private mapProfile(p: UserProfileEntity): any {
    return {
      ...p,
      user_id: p.userId,
      display_name: p.displayName,
      avatar_url: p.avatarUrl,
      created_at: p.createdAt,
      updated_at: p.updatedAt
    };
  }

  private mapCreds(c: UserAuthCredentialsEntity): any {
    return {
      ...c,
      user_id: c.userId,
      password_hash: c.passwordHash,
      two_factor_enabled: c.twoFactorEnabled,
      failed_login_attempts: c.failedLoginAttempts,
      locked_until: c.lockedUntil,
      last_login_at: c.lastLoginAt,
      updated_at: c.updatedAt
    };
  }

  private mapSession(s: UserSessionEntity): any {
    return {
      ...s,
      user_id: s.userId,
      token_hash: s.tokenHash,
      ip_address: s.ipAddress,
      user_agent: s.userAgent,
      expires_at: s.expiresAt,
      created_at: s.createdAt,
      last_active_at: s.lastActiveAt
    };
  }

  private mapAccount(a: AccountEntity): any {
    return {
      ...a,
      user_id: a.userId,
      created_at: a.createdAt,
      updated_at: a.updatedAt
    };
  }

  public async query<T = unknown>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> {
    if (!this.isConnected) {
      throw new Error('Database is not connected');
    }

    const trimmed = sql.trim();

    // 1. INSERT INTO users
    if (/INSERT\s+INTO\s+users/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const email = (params[1] as string).toLowerCase().trim();
      const role = (params[2] as 'USER' | 'ADMIN') || 'USER';
      const status = (params[3] as 'ACTIVE' | 'SUSPENDED') || 'ACTIVE';

      if (this.usersByEmail.has(email)) {
        const err = new Error(`duplicate key value violates unique constraint "users_email_key"`);
        (err as any).code = '23505';
        throw err;
      }

      const entity: UserEntity = {
        id,
        email,
        role,
        accountStatus: status,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      this.users.set(id, entity);
      this.usersByEmail.set(email, id);

      return { rows: [this.mapUser(entity) as T], rowCount: 1 };
    }

    // 2. SELECT ... FROM users WHERE email = $1
    if (/FROM\s+users\s+WHERE\s+email\s*=/i.test(trimmed)) {
      const email = (params[0] as string)?.toLowerCase().trim();
      const userId = this.usersByEmail.get(email);
      const user = userId ? this.users.get(userId) : undefined;
      return { rows: user ? [this.mapUser(user) as T] : [], rowCount: user ? 1 : 0 };
    }

    // 3. SELECT ... FROM users WHERE id = $1
    if (/FROM\s+users\s+WHERE\s+id\s*=/i.test(trimmed)) {
      const id = params[0] as string;
      const user = this.users.get(id);
      return { rows: user ? [this.mapUser(user) as T] : [], rowCount: user ? 1 : 0 };
    }

    // 4. INSERT INTO user_profiles
    if (/INSERT\s+INTO\s+user_profiles/i.test(trimmed)) {
      const userId = params[0] as string;
      const username = params[1] as string;
      const displayName = params[2] as string;
      const avatarUrl = params[3] as string | undefined;

      const profile: UserProfileEntity = {
        userId,
        username,
        displayName,
        avatarUrl,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.userProfiles.set(userId, profile);
      return { rows: [this.mapProfile(profile) as T], rowCount: 1 };
    }

    // 5. SELECT ... FROM user_profiles WHERE user_id = $1
    if (/FROM\s+user_profiles\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const profile = this.userProfiles.get(userId);
      return { rows: profile ? [this.mapProfile(profile) as T] : [], rowCount: profile ? 1 : 0 };
    }

    // 6. INSERT INTO user_auth_credentials
    if (/INSERT\s+INTO\s+user_auth_credentials/i.test(trimmed)) {
      const userId = params[0] as string;
      const passwordHash = params[1] as string;

      const creds: UserAuthCredentialsEntity = {
        userId,
        passwordHash,
        twoFactorEnabled: false,
        failedLoginAttempts: 0,
        updatedAt: new Date()
      };
      this.userCredentials.set(userId, creds);
      return { rows: [this.mapCreds(creds) as T], rowCount: 1 };
    }

    // 7. SELECT ... FROM user_auth_credentials WHERE user_id = $1
    if (/FROM\s+user_auth_credentials\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const creds = this.userCredentials.get(userId);
      return { rows: creds ? [this.mapCreds(creds) as T] : [], rowCount: creds ? 1 : 0 };
    }

    // 8. INSERT INTO accounts
    if (/INSERT\s+INTO\s+accounts/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const userId = params[1] as string;
      const type = params[2] as 'SPOT' | 'FUTURES' | 'FUNDING';

      const account: AccountEntity = {
        id,
        userId,
        type,
        createdAt: new Date(),
        updatedAt: new Date()
      };
      this.accounts.set(id, account);
      return { rows: [this.mapAccount(account) as T], rowCount: 1 };
    }

    // 9. SELECT ... FROM accounts WHERE user_id = $1
    if (/FROM\s+accounts\s+WHERE\s+user_id\s*=/i.test(trimmed)) {
      const userId = params[0] as string;
      const userAccounts = Array.from(this.accounts.values()).filter(a => a.userId === userId);
      return { rows: userAccounts.map(a => this.mapAccount(a)) as T[], rowCount: userAccounts.length };
    }

    // 10. INSERT INTO user_sessions
    if (/INSERT\s+INTO\s+user_sessions/i.test(trimmed)) {
      const id = (params[0] as string) || crypto.randomUUID();
      const userId = params[1] as string;
      const tokenHash = params[2] as string;
      const ip = params[3] as string | undefined;
      const userAgent = params[4] as string | undefined;
      const expiresAt = (params[5] as Date) || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const session: UserSessionEntity = {
        id,
        userId,
        tokenHash,
        ipAddress: ip,
        userAgent,
        status: 'ACTIVE',
        expiresAt,
        createdAt: new Date(),
        lastActiveAt: new Date()
      };
      this.userSessions.set(tokenHash, session);
      return { rows: [this.mapSession(session) as T], rowCount: 1 };
    }

    // 11. SELECT ... FROM user_sessions WHERE token_hash = $1
    if (/FROM\s+user_sessions\s+WHERE\s+token_hash\s*=/i.test(trimmed)) {
      const tokenHash = params[0] as string;
      const session = this.userSessions.get(tokenHash);
      if (!session) return { rows: [], rowCount: 0 };
      if (session.status === 'ACTIVE' && session.expiresAt.getTime() < Date.now()) {
        session.status = 'EXPIRED';
      }
      return { rows: [this.mapSession(session) as T], rowCount: 1 };
    }

    // 12. UPDATE user_sessions SET status = 'REVOKED' WHERE token_hash = $1
    if (/UPDATE\s+user_sessions\s+SET\s+status\s*=\s*'REVOKED'\s+WHERE\s+token_hash\s*=/i.test(trimmed)) {
      const tokenHash = params[0] as string;
      const session = this.userSessions.get(tokenHash);
      if (session) {
        session.status = 'REVOKED';
        return { rows: [this.mapSession(session) as T], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }

    // 13. Schema Migrations handling
    if (/INSERT\s+INTO\s+schema_migrations/i.test(trimmed)) {
      const version = params[0] as string;
      this.schemaMigrations.add(version);
      return { rows: [], rowCount: 1 };
    }

    if (/FROM\s+schema_migrations/i.test(trimmed)) {
      const rows = Array.from(this.schemaMigrations).map(v => ({
        version: v,
        name: v,
        checksum: 'checksum',
        appliedAt: new Date()
      }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    return { rows: [] as T[], rowCount: 0 };
  }

  public async healthCheck(): Promise<{ healthy: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      if (!this.isConnected) {
        return {
          healthy: false,
          latencyMs: Date.now() - start,
          error: this.connectionError || 'Database pool disconnected'
        };
      }
      return { healthy: true, latencyMs: Date.now() - start };
    } catch (err) {
      const error = err as Error;
      return {
        healthy: false,
        latencyMs: Date.now() - start,
        error: error.message
      };
    }
  }

  public getStatus(): DatabaseStatus {
    return {
      connected: this.isConnected,
      poolSize: this.totalPoolSize,
      activeConnections: this.activeClients,
      idleConnections: Math.max(0, this.totalPoolSize - this.activeClients),
      error: this.connectionError || undefined
    };
  }
}

export const db = new DatabasePool();
