import { describe, it, expect, beforeEach } from 'vitest';
import { totpService, base32Encode, base32Decode } from '../src/services/auth/totp.service';
import { authService } from '../src/services/auth/auth.service';

describe('Phase 7.1 — Two-Factor Authentication (TOTP) Unit Tests', () => {
  describe('RFC 4648 Base32 Encoding/Decoding', () => {
    it('correctly encodes and decodes arbitrary buffers', () => {
      const buffer = Buffer.from('Hello, World! 123');
      const encoded = base32Encode(buffer);
      expect(encoded).toBeDefined();
      expect(typeof encoded).toBe('string');
      expect(encoded.length).toBeGreaterThan(0);

      const decoded = base32Decode(encoded);
      expect(decoded.toString('utf8')).toBe('Hello, World! 123');
    });

    it('rejects invalid Base32 characters on decode', () => {
      expect(() => base32Decode('INVALID_1890_CHARS!!!')).toThrow(/Invalid Base32 character/);
    });
  });

  describe('RFC 6238 TOTP Generation & Verification', () => {
    const testSecret = 'JBSWY3DPEHPK3PXP'; // Standard test vector secret

    it('generates a valid 6-digit numeric token', () => {
      const token = totpService.generateToken(testSecret, Date.now());
      expect(token).toMatch(/^\d{6}$/);
    });

    it('verifies a valid token for current timestamp', () => {
      const now = Date.now();
      const token = totpService.generateToken(testSecret, now);
      const isValid = totpService.verifyToken(testSecret, token, 1, now);
      expect(isValid).toBe(true);
    });

    it('verifies token within ±30s clock drift window', () => {
      const now = 1700000000000;
      // Generate token 25 seconds in the past
      const pastToken = totpService.generateToken(testSecret, now - 25000);
      expect(totpService.verifyToken(testSecret, pastToken, 1, now)).toBe(true);

      // Generate token 25 seconds in the future
      const futureToken = totpService.generateToken(testSecret, now + 25000);
      expect(totpService.verifyToken(testSecret, futureToken, 1, now)).toBe(true);
    });

    it('rejects tokens outside the allowed drift window (>60s away)', () => {
      const now = 1700000000000;
      const expiredToken = totpService.generateToken(testSecret, now - 90000);
      expect(totpService.verifyToken(testSecret, expiredToken, 1, now)).toBe(false);
    });

    it('rejects incorrect tokens or malformed strings', () => {
      expect(totpService.verifyToken(testSecret, '000000')).toBe(false);
      expect(totpService.verifyToken(testSecret, 'abc')).toBe(false);
      expect(totpService.verifyToken(testSecret, '')).toBe(false);
    });
  });

  describe('Full 2FA Setup, Activation & Login Workflow', () => {
    let testUserId: string;
    let testEmail: string;
    const testPassword = 'Password123!Secure';

    beforeEach(async () => {
      const { db } = await import('../src/config/database');
      await db.connect();
      testEmail = `trader_2fa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}@example.com`;
      const res = await authService.signup({
        email: testEmail,
        password: testPassword,
        username: `tr2fa_${Date.now().toString().slice(-4)}_${Math.random().toString(36).slice(2, 6)}`
      });
      testUserId = res.user.id;
    });

    it('1. Generates secret and valid otpauth URI on setup', async () => {
      const setup = await authService.setup2FA(testUserId);
      expect(setup.secret).toBeDefined();
      expect(setup.secret.length).toBeGreaterThanOrEqual(16);
      expect(setup.otpauthUri).toContain('otpauth://totp/MallickExchange');
      expect(setup.otpauthUri).toContain(encodeURIComponent(testEmail));
    });

    it('2. Rejects enable with invalid token, succeeds with valid token', async () => {
      const setup = await authService.setup2FA(testUserId);
      
      // Invalid code fails
      await expect(authService.enable2FA(testUserId, '999999')).rejects.toThrow(/Invalid Two-Factor Authentication code/);

      // Valid code succeeds
      const validCode = totpService.generateToken(setup.secret);
      const enabled = await authService.enable2FA(testUserId, validCode);
      expect(enabled).toBe(true);

      const user = await authService.getUserById(testUserId);
      expect(user?.twoFactorEnabled).toBe(true);
    });

    it('3. Triggers 2FA challenge on login and completes via verify2FALogin', async () => {
      const setup = await authService.setup2FA(testUserId);
      const validCode = totpService.generateToken(setup.secret);
      await authService.enable2FA(testUserId, validCode);

      // Login without 2FA returns challenge
      const loginRes = await authService.login({
        email: testEmail,
        password: testPassword,
      });

      expect(loginRes.requires2FA).toBe(true);
      expect(loginRes.tempToken).toBeDefined();
      expect(loginRes.sessionToken).toBeUndefined();

      // Complete challenge with 2FA token
      const freshCode = totpService.generateToken(setup.secret);
      const completeRes = await authService.verify2FALogin(loginRes.tempToken!, freshCode);
      expect(completeRes.sessionToken).toBeDefined();
      expect(completeRes.user.id).toBe(testUserId);
    });

    it('4. Allows direct login if 2FA token is supplied upfront', async () => {
      const setup = await authService.setup2FA(testUserId);
      const validCode = totpService.generateToken(setup.secret);
      await authService.enable2FA(testUserId, validCode);

      const freshCode = totpService.generateToken(setup.secret);
      const loginRes = await authService.login({
        email: testEmail,
        password: testPassword,
        twoFactorToken: freshCode,
      });

      expect(loginRes.requires2FA).toBeUndefined();
      expect(loginRes.sessionToken).toBeDefined();
      expect(loginRes.user?.id).toBe(testUserId);
    });

    it('5. Securely disables 2FA with password and valid token verification', async () => {
      const setup = await authService.setup2FA(testUserId);
      const validCode = totpService.generateToken(setup.secret);
      await authService.enable2FA(testUserId, validCode);

      // Wrong password fails
      const freshCode = totpService.generateToken(setup.secret);
      await expect(authService.disable2FA(testUserId, 'WrongPassword!', freshCode)).rejects.toThrow(/Invalid password/);

      // Correct password and token succeeds
      const freshCode2 = totpService.generateToken(setup.secret);
      const disabled = await authService.disable2FA(testUserId, testPassword, freshCode2);
      expect(disabled).toBe(true);

      const user = await authService.getUserById(testUserId);
      expect(user?.twoFactorEnabled).toBe(false);
    });

        it('6. Rejects login completion with invalid/expired temporary token', async () => {
      await expect(authService.verify2FALogin('invalid_or_expired_token', '123456')).rejects.toThrow(/invalid/i);
    });
  });
});
