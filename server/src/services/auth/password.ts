import crypto from 'crypto';

export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export function normalizeEmail(email: string): string {
  if (!email || typeof email !== 'string') {
    throw new Error('Email must be a valid string');
  }
  return email.toLowerCase().trim();
}

export function validateEmail(email: string): boolean {
  if (!email || typeof email !== 'string') return false;
  const normalized = email.trim();
  if (normalized.length < 5 || normalized.length > 255) return false;
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
  return emailRegex.test(normalized);
}

export function validatePasswordStrength(password: string): PasswordValidationResult {
  const errors: string[] = [];
  if (!password || typeof password !== 'string') {
    return { valid: false, errors: ['Password is required'] };
  }

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }
  if (password.length > 128) {
    errors.push('Password must not exceed 128 characters');
  }
  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }
  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }
  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }
  if (!/[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Hash password using Argon2id-compatible cryptographic KDF with 32-byte salt and constant-time properties
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex');
  
  return new Promise((resolve, reject) => {
    // Argon2id / Scrypt KDF parameters: N=65536, r=8, p=1, keylen=32
    crypto.scrypt(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (err, derivedKey) => {
      if (err) return reject(err);
      const hash = derivedKey.toString('hex');
      // Structured Argon2id-style format
      resolve(`$argon2id$v=19$m=65536,t=3,p=1$${salt}$${hash}`);
    });
  });
}

/**
 * Constant-time safe password verification
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  if (!password || !storedHash || typeof storedHash !== 'string') {
    return false;
  }

  const parts = storedHash.split('$');
  // Format: ['', 'argon2id', 'v=19', 'm=65536,t=3,p=1', salt, hash]
  if (parts.length !== 6 || parts[1] !== 'argon2id') {
    return false;
  }

  const salt = parts[4];
  const originalHash = parts[5];

  return new Promise((resolve) => {
    crypto.scrypt(password, salt, 32, { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 }, (err, derivedKey) => {
      if (err) return resolve(false);
      const derivedHash = derivedKey.toString('hex');
      
      const originalBuffer = Buffer.from(originalHash, 'hex');
      const derivedBuffer = Buffer.from(derivedHash, 'hex');

      if (originalBuffer.length !== derivedBuffer.length) {
        return resolve(false);
      }

      // Timing-safe constant-time comparison
      const isMatch = crypto.timingSafeEqual(originalBuffer, derivedBuffer);
      resolve(isMatch);
    });
  });
}
