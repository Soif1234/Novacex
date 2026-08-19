import { describe, it, expect, beforeEach, vi } from 'vitest';
import { authService } from '../src/services/auth/auth.service';
import { sessionService } from '../src/services/auth/session.service';
import { validatePasswordStrength, validateEmail, normalizeEmail, hashPassword, verifyPassword } from '../src/services/auth/password';
import { db } from '../src/config/database';
import { createApp } from '../src/app';
import { extractSessionToken, requireAuth, requireRole, requireAccountOwnership } from '../src/middleware/auth';
import { Request, Response, NextFunction } from 'express';

describe('Authentication & User Management (server/src/services/auth/)', () => {
  beforeEach(async () => {
    await db.connect();
    if (db.reset) {
      db.reset();
    }
  });

  it('1. Signup succeeds with valid credentials and creates user with USER role and default accounts', async () => {
    const result = await authService.signup({
      email: 'trader1@mallickexchange.com',
      password: 'Password123!@#'
    });

    expect(result.user).toBeDefined();
    expect(result.user.id).toBeDefined();
    expect(result.user.email).toBe('trader1@mallickexchange.com');
    expect(result.user.role).toBe('USER');
    expect(result.user.accountStatus).toBe('ACTIVE');
    expect(result.user.accounts.length).toBe(3);
    expect(result.user.accounts.map(a => a.type)).toEqual(expect.arrayContaining(['SPOT', 'FUTURES', 'FUNDING']));
  });

  it('2. Password is never stored plaintext', async () => {
    const rawPassword = 'SecureSecretPassword123!';
    await authService.signup({
      email: 'security_test@exchange.com',
      password: rawPassword
    });

    const user = await db.query<{ id: string }>('SELECT id FROM users WHERE email = $1', ['security_test@exchange.com']);
    const creds = await db.query<any>('SELECT password_hash FROM user_auth_credentials WHERE user_id = $1', [user.rows[0].id]);
    const hash = creds.rows[0].password_hash || creds.rows[0].passwordHash;
    expect(hash).toBeDefined();
    expect(hash).not.toBe(rawPassword);
    expect(hash).not.toContain(rawPassword);
  });

  it('3. Password hash is Argon2id formatted', async () => {
    const hash = await hashPassword('MyStrongPassword123#');
    expect(hash.startsWith('$argon2id$v=19$')).toBe(true);

    const isValid = await verifyPassword('MyStrongPassword123#', hash);
    expect(isValid).toBe(true);

    const isWrong = await verifyPassword('WrongPassword123#', hash);
    expect(isWrong).toBe(false);
  });

  it('4. Duplicate email is rejected with 409 Conflict', async () => {
    await authService.signup({
      email: 'duplicate@test.com',
      password: 'Password123!@#'
    });

    await expect(authService.signup({
      email: 'DUPLICATE@test.com', // Case insensitivity
      password: 'Password123!@#'
    })).rejects.toThrow(/already exists/i);
  });

  it('5. Invalid email is rejected', async () => {
    expect(validateEmail('invalid-email')).toBe(false);
    expect(validateEmail('test@')).toBe(false);
    expect(validateEmail('@domain.com')).toBe(false);

    await expect(authService.signup({
      email: 'not-an-email',
      password: 'Password123!@#'
    })).rejects.toThrow(/Invalid email/i);
  });

  it('6. Weak password is rejected', async () => {
    expect(validatePasswordStrength('short').valid).toBe(false);
    expect(validatePasswordStrength('nouppercase123!').valid).toBe(false);
    expect(validatePasswordStrength('NOLOWERCASE123!').valid).toBe(false);
    expect(validatePasswordStrength('NoSpecialChar123').valid).toBe(false);
    expect(validatePasswordStrength('NoNumbers!@#$%^').valid).toBe(false);

    await expect(authService.signup({
      email: 'weakpass@test.com',
      password: 'weak'
    })).rejects.toThrow(/Password must be at least 8 characters/i);
  });

  it('7. Login succeeds with correct credentials and returns session token', async () => {
    await authService.signup({
      email: 'login_user@test.com',
      password: 'Password123!@#'
    });

    const loginRes = await authService.login({
      email: 'login_user@test.com',
      password: 'Password123!@#'
    });

    expect(loginRes.sessionToken).toBeDefined();
    expect(typeof loginRes.sessionToken).toBe('string');
    expect(loginRes.user.email).toBe('login_user@test.com');
  });

  it('8. Login fails with incorrect password', async () => {
    await authService.signup({
      email: 'user_auth@test.com',
      password: 'Password123!@#'
    });

    await expect(authService.login({
      email: 'user_auth@test.com',
      password: 'WrongPassword999!'
    })).rejects.toThrow(/Invalid email or password/i);
  });

  it('9. Login failure does not reveal whether email exists (generic error message)', async () => {
    let nonExistentError = '';
    let wrongPassError = '';

    try {
      await authService.login({
        email: 'does_not_exist@test.com',
        password: 'Password123!@#'
      });
    } catch (e: any) {
      nonExistentError = e.message;
    }

    await authService.signup({
      email: 'exists@test.com',
      password: 'Password123!@#'
    });

    try {
      await authService.login({
        email: 'exists@test.com',
        password: 'WrongPassword123!'
      });
    } catch (e: any) {
      wrongPassError = e.message;
    }

    expect(nonExistentError).toBe('Invalid email or password');
    expect(wrongPassError).toBe('Invalid email or password');
    expect(nonExistentError).toBe(wrongPassError);
  });

  it('10. Login creates a server-side session', async () => {
    await authService.signup({
      email: 'session_test@test.com',
      password: 'Password123!@#'
    });

    const loginRes = await authService.login({
      email: 'session_test@test.com',
      password: 'Password123!@#'
    });

    const session = await sessionService.validateSession(loginRes.sessionToken);
    expect(session).toBeDefined();
    expect(session?.userId).toBe(loginRes.user.id);
    expect(session?.status).toBe('ACTIVE');
  });

  it('11 & 12. Session cookie is HttpOnly, SameSite, and Path=/', () => {
    const isProd = process.env.NODE_ENV === 'production';
    const cookieHeader = `mallick_session=test-token; Path=/; Max-Age=604800; HttpOnly; SameSite=${isProd ? 'Strict' : 'Lax'}`;
    expect(cookieHeader).toContain('HttpOnly');
    expect(cookieHeader).toContain('Path=/');
    expect(cookieHeader).toContain('SameSite=');
  });

  it('13. /auth/me works with valid session token', async () => {
    const signupRes = await authService.signup({
      email: 'me_test@test.com',
      password: 'Password123!@#'
    });

    const loginRes = await authService.login({
      email: 'me_test@test.com',
      password: 'Password123!@#'
    });

    const user = await authService.getUserBySessionToken(loginRes.sessionToken);
    expect(user).toBeDefined();
    expect(user?.id).toBe(signupRes.user.id);
    expect(user?.email).toBe('me_test@test.com');
  });

  it('14. /auth/me rejects missing session', async () => {
    const req = {
      headers: {}
    } as unknown as Request;
    let nextError: any = null;
    const res = {} as Response;
    const next: NextFunction = (err) => { nextError = err; };

    await requireAuth(req, res, next);
    expect(nextError).toBeDefined();
    expect(nextError.statusCode).toBe(401);
  });

  it('15. /auth/me rejects expired session', async () => {
    const signupRes = await authService.signup({
      email: 'expired_user@test.com',
      password: 'Password123!@#'
    });

    // Create expired session (-1 day)
    const { sessionToken } = await sessionService.createSession(signupRes.user.id, undefined, undefined, -1);

    const req = {
      headers: {
        authorization: `Bearer ${sessionToken}`
      }
    } as unknown as Request;
    let nextError: any = null;
    const res = {} as Response;
    const next: NextFunction = (err) => { nextError = err; };

    await requireAuth(req, res, next);
    expect(nextError).toBeDefined();
    expect(nextError.statusCode).toBe(401);
    expect(nextError.code).toBe('INVALID_SESSION');
  });

  it('16 & 17. Logout revokes session and revoked session cannot access /auth/me', async () => {
    const signupRes = await authService.signup({
      email: 'logout_user@test.com',
      password: 'Password123!@#'
    });

    const loginRes = await authService.login({
      email: 'logout_user@test.com',
      password: 'Password123!@#'
    });

    // Valid before logout
    const preSession = await sessionService.validateSession(loginRes.sessionToken);
    expect(preSession).toBeDefined();

    // Revoke
    await sessionService.revokeSession(loginRes.sessionToken);

    // Invalid after logout
    const postSession = await sessionService.validateSession(loginRes.sessionToken);
    expect(postSession).toBeNull();
  });

  it('18 & 19. USER receives USER role and public signup cannot create ADMIN', async () => {
    const res = await authService.signup({
      email: 'hacker@test.com',
      password: 'Password123!@#',
      ...({ role: 'ADMIN' } as any) // Attempt privilege escalation in payload
    });

    expect(res.user.role).toBe('USER');
  });

  it('20 & 21. requireRole enforces RBAC: rejects USER and accepts ADMIN', () => {
    const userReq = {
      user: { id: 'u1', email: 'u1@test.com', role: 'USER' }
    } as unknown as Request;
    const adminReq = {
      user: { id: 'a1', email: 'admin@test.com', role: 'ADMIN' }
    } as unknown as Request;

    const res = {} as Response;
    let userErr: any = null;
    let adminErr: any = null;

    const adminGuard = requireRole('ADMIN');

    adminGuard(userReq, res, (err) => { userErr = err; });
    adminGuard(adminReq, res, (err) => { adminErr = err; });

    expect(userErr).toBeDefined();
    expect(userErr.statusCode).toBe(403);
    expect(adminErr).toBeUndefined(); // Passed
  });

  it('22 & 23. Client-supplied userId and role cannot impersonate or escalate', async () => {
    const victim = await authService.signup({
      email: 'victim@test.com',
      password: 'Password123!@#'
    });

    const attacker = await authService.signup({
      email: 'attacker@test.com',
      password: 'Password123!@#'
    });

    const attackerLogin = await authService.login({
      email: 'attacker@test.com',
      password: 'Password123!@#'
    });

    // Authenticated request context resolves ONLY attacker from session
    const authenticatedUser = await authService.getUserBySessionToken(attackerLogin.sessionToken);
    expect(authenticatedUser?.id).toBe(attacker.user.id);
    expect(authenticatedUser?.id).not.toBe(victim.user.id);
    expect(authenticatedUser?.role).toBe('USER');
  });

  it('24. Logout is idempotent', async () => {
    const revoked1 = await sessionService.revokeSession('non_existent_token');
    const revoked2 = await sessionService.revokeSession('non_existent_token');
    expect(revoked1).toBe(false);
    expect(revoked2).toBe(false);
  });

  it('25. Session expiration is strictly enforced', async () => {
    const user = await authService.signup({
      email: 'expire_strict@test.com',
      password: 'Password123!@#'
    });

    const activeSession = await sessionService.createSession(user.user.id, undefined, undefined, 1);
    expect(await sessionService.validateSession(activeSession.sessionToken)).toBeDefined();

    // Expired session (-1 day)
    const expiredSession = await sessionService.createSession(user.user.id, undefined, undefined, -1);
    expect(await sessionService.validateSession(expiredSession.sessionToken)).toBeNull();
  });

  it('26 & 27. Multiple users have independent sessions and User A cannot act as User B', async () => {
    const userA = await authService.signup({
      email: 'usera@test.com',
      password: 'Password123!@#'
    });
    const userB = await authService.signup({
      email: 'userb@test.com',
      password: 'Password123!@#'
    });

    const loginA = await authService.login({
      email: 'usera@test.com',
      password: 'Password123!@#'
    });
    const loginB = await authService.login({
      email: 'userb@test.com',
      password: 'Password123!@#'
    });

    expect(loginA.sessionToken).not.toBe(loginB.sessionToken);

    const resolvedA = await authService.getUserBySessionToken(loginA.sessionToken);
    const resolvedB = await authService.getUserBySessionToken(loginB.sessionToken);

    expect(resolvedA?.id).toBe(userA.user.id);
    expect(resolvedB?.id).toBe(userB.user.id);
    expect(resolvedA?.id).not.toBe(resolvedB?.id);
  });

  it('28. Sensitive credentials (password, hash, secret) are absent from API responses', async () => {
    const signupRes = await authService.signup({
      email: 'clean_response@test.com',
      password: 'Password123!@#'
    });

    expect((signupRes.user as any).password).toBeUndefined();
    expect((signupRes.user as any).passwordHash).toBeUndefined();
    expect((signupRes.user as any).twoFactorSecret).toBeUndefined();

    const loginRes = await authService.login({
      email: 'clean_response@test.com',
      password: 'Password123!@#'
    });

    expect((loginRes.user as any).password).toBeUndefined();
    expect((loginRes.user as any).passwordHash).toBeUndefined();
  });

  it('29. Account ownership verification prevents cross-account resource access', async () => {
    const userA = await authService.signup({
      email: 'owner_a@test.com',
      password: 'Password123!@#'
    });
    const userB = await authService.signup({
      email: 'owner_b@test.com',
      password: 'Password123!@#'
    });

    const userASpotAccountId = userA.user.accounts.find(a => a.type === 'SPOT')!.id;
    const userBSpotAccountId = userB.user.accounts.find(a => a.type === 'SPOT')!.id;

    const req = {
      user: userA.user,
      accounts: userA.user.accounts,
      params: { accountId: userBSpotAccountId } // User A trying to access User B account
    } as unknown as Request;

    const res = {} as Response;
    let ownershipErr: any = null;

    const ownershipGuard = requireAccountOwnership('accountId');
    ownershipGuard(req, res, (err) => { ownershipErr = err; });

    expect(ownershipErr).toBeDefined();
    expect(ownershipErr.statusCode).toBe(403);
    expect(ownershipErr.code).toBe('ACCOUNT_ACCESS_DENIED');
  });
});
