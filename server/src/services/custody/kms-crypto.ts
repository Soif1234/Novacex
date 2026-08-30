import { ethers } from 'ethers';

const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const HALF_N = N / 2n;

export function getAddressFromKmsPublicKey(spkiDer: Buffer | Uint8Array): string {
    const buffer = Buffer.from(spkiDer);
    let offset = 0;

    function readLength(): number {
        let length = buffer[offset++];
        if (length & 0x80) {
            const numBytes = length & 0x7F;
            length = 0;
            for (let i = 0; i < numBytes; i++) {
                length = (length << 8) | buffer[offset++];
            }
        }
        return length;
    }

    if (buffer[offset++] !== 0x30) throw new Error("Invalid KMS public key: Expected SEQUENCE");
    readLength(); // sequence length

    if (buffer[offset++] !== 0x30) throw new Error("Invalid KMS public key: Expected SEQUENCE (AlgorithmIdentifier)");
    const algLen = readLength();
    const algEnd = offset + algLen;

    if (buffer[offset++] !== 0x06) throw new Error("Invalid KMS public key: Expected OID");
    const oid1Len = readLength();
    const oid1 = buffer.subarray(offset, offset + oid1Len);
    offset += oid1Len;
    if (oid1.toString('hex') !== '2a8648ce3d0201') {
        throw new Error("Invalid KMS public key: Not id-ecPublicKey");
    }

    if (buffer[offset++] !== 0x06) throw new Error("Invalid KMS public key: Expected OID");
    const oid2Len = readLength();
    const oid2 = buffer.subarray(offset, offset + oid2Len);
    offset += oid2Len;
    if (oid2.toString('hex') !== '2b8104000a') {
        throw new Error("Invalid KMS public key: SPKI does not contain secp256k1 OID. NIST P-256 and other curves are not supported on Ethereum.");
    }

    if (offset !== algEnd) throw new Error("Invalid KMS public key: Unexpected data in AlgorithmIdentifier");

    if (buffer[offset++] !== 0x03) throw new Error("Invalid KMS public key: Expected BIT STRING");
    const bitLen = readLength();
    if (buffer[offset++] !== 0x00) throw new Error("Invalid KMS public key: Expected 0 unused bits in BIT STRING");

    const keyBytes = buffer.subarray(offset, offset + bitLen - 1);

    if (keyBytes.length !== 65) throw new Error("Invalid KMS public key length");
    if (keyBytes[0] !== 0x04) throw new Error("Expected uncompressed public key starting with 0x04");

    // ethers v6 requires exact Uint8Array or hex string, Buffer may fail type checks
    const rawKey = new Uint8Array(keyBytes.buffer, keyBytes.byteOffset + 1, 64);
    const hash = ethers.keccak256(rawKey);
    return ethers.getAddress('0x' + hash.slice(-40));
}

export function parseKmsSignature(derSignature: Buffer | Uint8Array, digest: string, expectedAddress: string): ethers.Signature {
    const sig = Buffer.from(derSignature);
    if (sig[0] !== 0x30) throw new Error("Invalid DER signature: missing 0x30");
    let pos = 2; // skip 0x30 and length
    if (sig[pos] !== 0x02) throw new Error("Invalid DER signature: expected integer (R)");

    let rLen = sig[pos + 1];
    let rPos = pos + 2;
    pos = rPos + rLen;
    let rBytes = sig.subarray(rPos, rPos + rLen);

    if (sig[pos] !== 0x02) throw new Error("Invalid DER signature: expected integer (S)");
    let sLen = sig[pos + 1];
    let sPos = pos + 2;
    let sBytes = sig.subarray(sPos, sPos + sLen);

    // Strip leading zero if present
    if (rBytes.length === 33 && rBytes[0] === 0x00) rBytes = rBytes.subarray(1);
    if (sBytes.length === 33 && sBytes[0] === 0x00) sBytes = sBytes.subarray(1);

    if (rBytes.length !== 32) rBytes = Buffer.concat([Buffer.alloc(32 - rBytes.length, 0), rBytes]);
    if (sBytes.length !== 32) sBytes = Buffer.concat([Buffer.alloc(32 - sBytes.length, 0), sBytes]);

    const rHex = '0x' + rBytes.toString('hex');
    let sBigInt = BigInt('0x' + sBytes.toString('hex'));

    if (sBigInt > HALF_N) {
        sBigInt = N - sBigInt;
    }
    const sHex = '0x' + sBigInt.toString(16).padStart(64, '0');

    let v = 27;
    let recovered0 = ethers.recoverAddress(digest, { r: rHex, s: sHex, v: 27 });
    if (recovered0.toLowerCase() !== expectedAddress.toLowerCase()) {
        v = 28;
        let recovered1 = ethers.recoverAddress(digest, { r: rHex, s: sHex, v: 28 });
        if (recovered1.toLowerCase() !== expectedAddress.toLowerCase()) {
            throw new Error("Failed to determine recovery ID: signature does not match expected address");
        }
    }

    return ethers.Signature.from({ r: rHex, s: sHex, v: v });
}