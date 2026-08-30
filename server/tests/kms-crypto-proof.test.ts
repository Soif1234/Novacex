import { describe, it, expect } from 'vitest';
import crypto from 'crypto';

/**
 * STANDALONE KMS CRYPTOGRAPHIC PROOF
 * This module isolates the cryptographic transformations required to bridge Cloud KMS with EVM/Bitcoin.
 * No production state or keys are used.
 */

// 1. LOCAL KMS MOCK
class LocalKmsMock {
  private privateKey: crypto.KeyObject;
  public publicKeyPem: string;

  constructor() {
    // Generate deterministic/disposable test key (secp256k1)
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'secp256k1',
    });
    this.privateKey = privateKey;
    this.publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;
  }

  // Returns ASN.1 DER encoded ECDSA signature
  public sign(digest: Buffer): Buffer {
    const sign = crypto.createSign('SHA256');
    sign.update(digest);
    return sign.sign(this.privateKey);
  }
}

// 2. CRYPTOGRAPHIC TRANSFORMATIONS
function decodeDERSignature(der: Buffer): { r: Buffer; s: Buffer } {
  // ASN.1 DER ECDSA signature format:
  // 0x30 <length> 0x02 <r-length> <r> 0x02 <s-length> <s>
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error('Invalid DER: expected sequence (0x30)');
  const seqLength = der[offset++]; // Assuming length < 128 for ECDSA
  if (der[offset++] !== 0x02) throw new Error('Invalid DER: expected integer (0x02) for r');
  const rLen = der[offset++];
  const r = der.subarray(offset, offset + rLen);
  offset += rLen;
  if (der[offset++] !== 0x02) throw new Error('Invalid DER: expected integer (0x02) for s');
  const sLen = der[offset++];
  const s = der.subarray(offset, offset + sLen);

  return { r, s };
}

function normalizeLowS(s: Buffer): Buffer {
  // secp256k1 curve order N
  const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141');
  const HALF_N = N / 2n;

  const sBig = BigInt('0x' + s.toString('hex'));
  if (sBig > HALF_N) {
    const normalized = N - sBig;
    let hex = normalized.toString(16);
    if (hex.length % 2 !== 0) hex = '0' + hex;
    return Buffer.from(hex, 'hex');
  }
  return s;
}

function computeRecoveryId(r: Buffer, s: Buffer, digest: Buffer, publicKeyPem: string): number {
  // Node.js crypto doesn't provide ecrecover out of the box.
  // In a real environment with ethers.js, we would attempt recoverAddress(digest, {r, s, v: 0})
  // and recoverAddress(digest, {r, s, v: 1}) to see which matches the KMS public key.
  // Stubbed for this environment constraint.
  return 0; // Mocked
}

describe('KMS Cryptographic Pipeline', () => {
  it('should successfully decode DER, extract R/S, and normalize S', () => {
    const kms = new LocalKmsMock();
    const mockDigest = Buffer.from('deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef', 'hex');

    // 1. Sign
    const derSig = kms.sign(mockDigest);
    expect(derSig[0]).toBe(0x30); // Valid DER

    // 2. Decode
    const { r, s } = decodeDERSignature(derSig);
    expect(r.length).toBeGreaterThanOrEqual(32);
    expect(s.length).toBeGreaterThanOrEqual(32);

    // 3. Normalize S
    const normalizedS = normalizeLowS(s);
    const sBig = BigInt('0x' + normalizedS.toString('hex'));
    const HALF_N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141') / 2n;
    expect(sBig).toBeLessThanOrEqual(HALF_N);
  });
});
