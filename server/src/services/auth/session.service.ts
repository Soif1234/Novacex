import crypto from 'crypto';
import { db, IDatabaseConnection } from '../../config/database';
import { UserSessionEntity } from '../../models/user.model';
import { logger } from '../../config/logger';

export class SessionService {
  constructor(private database: IDatabaseConnection = db) {}

  public hashToken(rawToken: string): string {
    return crypto.createHash('sha256').update(rawToken).digest('hex');
  }

  public async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    ttlDays = 7
  ): Promise<{ sessionToken: string; session: UserSessionEntity }> {
    // Generate 32 bytes (256 bits) of cryptographic randomness
    const sessionToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = this.hashToken(sessionToken);
    const sessionId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

    const query = `
      INSERT INTO user_sessions (id, user_id, token_hash, ip_address, user_agent, status, expires_at)
      VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
    `;

    const result = await this.database.query<any>(query, [
      sessionId,
      userId,
      tokenHash,
      ipAddress,
      userAgent,
      expiresAt
    ]);

    const row = result.rows[0];
    const session: UserSessionEntity = {
      id: row?.id || sessionId,
      userId: row?.userId || row?.user_id || userId,
      tokenHash: row?.tokenHash || row?.token_hash || tokenHash,
      ipAddress: row?.ipAddress || row?.ip_address || ipAddress,
      userAgent: row?.userAgent || row?.user_agent || userAgent,
      status: (row?.status || 'ACTIVE') as 'ACTIVE' | 'REVOKED' | 'EXPIRED',
      expiresAt: row?.expiresAt ? new Date(row.expiresAt) : expiresAt,
      createdAt: row?.createdAt ? new Date(row.createdAt) : new Date(),
      lastActiveAt: row?.lastActiveAt ? new Date(row.lastActiveAt) : new Date()
    };

    logger.info('Created new user session', { userId, sessionId: session.id });

    return {
      sessionToken,
      session
    };
  }

  public async validateSession(rawToken: string): Promise<UserSessionEntity | null> {
    if (!rawToken || typeof rawToken !== 'string' || rawToken.trim().length === 0) {
      return null;
    }

    const tokenHash = this.hashToken(rawToken.trim());
    const query = `
      SELECT id, user_id, token_hash, ip_address, user_agent, status, expires_at, created_at, last_active_at
      FROM user_sessions
      WHERE token_hash = $1
    `;

    const result = await this.database.query<any>(query, [tokenHash]);
    const row = result.rows[0];

    if (!row) {
      return null;
    }

    const session: UserSessionEntity = {
      id: row.id,
      userId: row.userId || row.user_id,
      tokenHash: row.tokenHash || row.token_hash,
      ipAddress: row.ipAddress || row.ip_address,
      userAgent: row.userAgent || row.user_agent,
      status: row.status,
      expiresAt: new Date(row.expiresAt || row.expires_at),
      createdAt: new Date(row.createdAt || row.created_at),
      lastActiveAt: new Date(row.lastActiveAt || row.last_active_at)
    };

    if (session.status !== 'ACTIVE') {
      return null;
    }

    if (session.expiresAt.getTime() <= Date.now()) {
      session.status = 'EXPIRED';
      return null;
    }

    return session;
  }

  public async revokeSession(rawToken: string): Promise<boolean> {
    if (!rawToken || typeof rawToken !== 'string') {
      return false;
    }

    const tokenHash = this.hashToken(rawToken.trim());
    const query = `
      UPDATE user_sessions SET status = 'REVOKED' WHERE token_hash = $1
    `;

    const result = await this.database.query(query, [tokenHash]);
    logger.info('Revoked session token', { tokenHash: tokenHash.substring(0, 8) + '...' });
    return result.rowCount > 0;
  }

  public async authenticateSession(rawToken: string): Promise<{ id: string; email: string } | null> {
    const session = await this.validateSession(rawToken);
    if (!session) {
      return null;
    }

    const userRes = await this.database.query<any>('SELECT id, email FROM users WHERE id = $1', [session.userId]);
    const userRow = userRes.rows[0];
    if (!userRow) {
      return null;
    }

    return {
      id: userRow.id,
      email: userRow.email,
    };
  }
}


export const sessionService = new SessionService();
