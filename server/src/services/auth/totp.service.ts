import crypto from 'crypto';

/**
 * Base32 Alphabet according to RFC 4648
 */
const BASE32_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }

  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    const val = BASE32_CHARS.indexOf(char);
    if (val === -1) {
      throw new Error(`Invalid Base32 character: ${char}`);
    }

    value = (value << 5) | val;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export interface TotpSetupResult {
  secret: string; // Base32 formatted secret
  otpauthUri: string; // Standard otpauth URI for QR code generators
}

export class TotpService {
  private readonly stepSeconds = 30;
  private readonly digits = 6;

  /**
   * Generate a fresh 160-bit (20-byte) Base32 secret for 2FA setup.
   */
  public generateSecret(email: string, issuer = 'MallickExchange'): TotpSetupResult {
    const randomBytes = crypto.randomBytes(20);
    const secret = base32Encode(randomBytes);
    const encodedIssuer = encodeURIComponent(issuer);
    const encodedLabel = encodeURIComponent(`${issuer}:${email}`);
    const otpauthUri = `otpauth://totp/${encodedLabel}?secret=${secret}&issuer=${encodedIssuer}&algorithm=SHA1&digits=6&period=30`;

    return {
      secret,
      otpauthUri,
    };
  }

  /**
   * Generate a 6-digit TOTP code for a given timestamp (default: now).
   */
  public generateToken(secret: string, timeMs: number = Date.now()): string {
    const key = base32Decode(secret);
    const counter = Math.floor(timeMs / 1000 / this.stepSeconds);

    const buffer = Buffer.alloc(8);
    buffer.writeBigInt64BE(BigInt(counter), 0);

    const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
    const offset = hmac[hmac.length - 1] & 0x0f;
    const binary =
      ((hmac[offset] & 0x7f) << 24) |
      ((hmac[offset + 1] & 0xff) << 16) |
      ((hmac[offset + 2] & 0xff) << 8) |
      (hmac[offset + 3] & 0xff);

    const otp = binary % Math.pow(10, this.digits);
    return otp.toString().padStart(this.digits, '0');
  }

  /**
   * Verify a user-provided 6-digit token against the secret, allowing for clock drift.
   * Window = 1 means checking counter - 1, counter, counter + 1 (±30 seconds).
   */
  public verifyToken(secret: string, token: string, window = 1, timeMs: number = Date.now()): boolean {
    if (!token || typeof token !== 'string' || token.trim().length !== this.digits) {
      return false;
    }

    const cleanToken = token.trim();
    const currentCounter = Math.floor(timeMs / 1000 / this.stepSeconds);

    try {
      const key = base32Decode(secret);

      for (let i = -window; i <= window; i++) {
        const counter = currentCounter + i;
        const buffer = Buffer.alloc(8);
        buffer.writeBigInt64BE(BigInt(counter), 0);

        const hmac = crypto.createHmac('sha1', key).update(buffer).digest();
        const offset = hmac[hmac.length - 1] & 0x0f;
        const binary =
          ((hmac[offset] & 0x7f) << 24) |
          ((hmac[offset + 1] & 0xff) << 16) |
          ((hmac[offset + 2] & 0xff) << 8) |
          (hmac[offset + 3] & 0xff);

        const expectedOtp = (binary % Math.pow(10, this.digits)).toString().padStart(this.digits, '0');

        if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(expectedOtp))) {
          return true;
        }
      }
    } catch {
      return false;
    }

    return false;
  }
}

export const totpService = new TotpService();
