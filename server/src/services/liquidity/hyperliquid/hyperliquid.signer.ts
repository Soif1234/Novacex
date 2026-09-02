/**
 * Hyperliquid EIP-712 Signer & Canonical Msgpack Encoding
 * Phase 10.5 â€” Step 10.5-2
 */

import { ethers } from 'ethers';
import {
  HyperliquidL1Action,
  HyperliquidSignature,
  HyperliquidError,
  HyperliquidErrorCode
} from './hyperliquid.types';

export const HYPERLIQUID_EIP712_DOMAIN = {
  name: 'Exchange',
  version: '1',
  chainId: 1337,
  verifyingContract: '0x0000000000000000000000000000000000000000'
};

export const HYPERLIQUID_EIP712_TYPES: Record<string, ethers.TypedDataField[]> = {
  Agent: [
    { name: 'source', type: 'string' },
    { name: 'connectionId', type: 'bytes32' }
  ]
};

export class HyperliquidMsgpackEncoder {
  /**
   * Deterministic recursive Msgpack serialization matching official Python/TypeScript SDK specs.
   */
  public static encode(value: any): Buffer {
    if (value === null || value === undefined) {
      return Buffer.from([0xc0]);
    }

    if (typeof value === 'boolean') {
      return Buffer.from([value ? 0xc3 : 0xc2]);
    }

    if (typeof value === 'number') {
      if (Number.isInteger(value)) {
        return this.encodeInteger(value);
      } else {
        const buf = Buffer.alloc(9);
        buf[0] = 0xcb; // float64
        buf.writeDoubleBE(value, 1);
        return buf;
      }
    }

    if (typeof value === 'bigint') {
      const buf = Buffer.alloc(9);
      buf[0] = 0xcf; // uint64
      buf.writeBigUInt64BE(value, 1);
      return buf;
    }

    if (typeof value === 'string') {
      const strBytes = Buffer.from(value, 'utf8');
      const len = strBytes.length;
      if (len <= 31) {
        return Buffer.concat([Buffer.from([0xa0 | len]), strBytes]);
      } else if (len <= 255) {
        return Buffer.concat([Buffer.from([0xd9, len]), strBytes]);
      } else if (len <= 65535) {
        const header = Buffer.alloc(3);
        header[0] = 0xda;
        header.writeUInt16BE(len, 1);
        return Buffer.concat([header, strBytes]);
      } else {
        const header = Buffer.alloc(5);
        header[0] = 0xdb;
        header.writeUInt32BE(len, 1);
        return Buffer.concat([header, strBytes]);
      }
    }

    if (Array.isArray(value)) {
      const encodedElements = value.map(el => this.encode(el));
      const totalLen = value.length;
      let header: Buffer;
      if (totalLen <= 15) {
        header = Buffer.from([0x90 | totalLen]);
      } else if (totalLen <= 65535) {
        header = Buffer.alloc(3);
        header[0] = 0xdc;
        header.writeUInt16BE(totalLen, 1);
      } else {
        header = Buffer.alloc(5);
        header[0] = 0xdd;
        header.writeUInt32BE(totalLen, 1);
      }
      return Buffer.concat([header, ...encodedElements]);
    }

    if (typeof value === 'object') {
      const keys = Object.keys(value).filter(k => value[k] !== undefined);
      const totalKeys = keys.length;
      let header: Buffer;
      if (totalKeys <= 15) {
        header = Buffer.from([0x80 | totalKeys]);
      } else if (totalKeys <= 65535) {
        header = Buffer.alloc(3);
        header[0] = 0xde;
        header.writeUInt16BE(totalKeys, 1);
      } else {
        header = Buffer.alloc(5);
        header[0] = 0xdf;
        header.writeUInt32BE(totalKeys, 1);
      }

      const pairs: Buffer[] = [];
      for (const key of keys) {
        pairs.push(this.encode(key));
        pairs.push(this.encode(value[key]));
      }
      return Buffer.concat([header, ...pairs]);
    }

    throw new HyperliquidError(
      HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
      `Unsupported msgpack data type: ${typeof value}`
    );
  }

  private static encodeInteger(val: number): Buffer {
    if (val >= 0) {
      if (val <= 127) {
        return Buffer.from([val]);
      } else if (val <= 255) {
        return Buffer.from([0xcc, val]);
      } else if (val <= 65535) {
        const buf = Buffer.alloc(3);
        buf[0] = 0xcd;
        buf.writeUInt16BE(val, 1);
        return buf;
      } else if (val <= 4294967295) {
        const buf = Buffer.alloc(5);
        buf[0] = 0xce;
        buf.writeUInt32BE(val, 1);
        return buf;
      } else {
        const buf = Buffer.alloc(9);
        buf[0] = 0xcf;
        buf.writeBigUInt64BE(BigInt(val), 1);
        return buf;
      }
    } else {
      if (val >= -32) {
        return Buffer.from([0xe0 | (val + 32)]);
      } else if (val >= -128) {
        const buf = Buffer.alloc(2);
        buf[0] = 0xd0;
        buf.writeInt8(val, 1);
        return buf;
      } else if (val >= -32768) {
        const buf = Buffer.alloc(3);
        buf[0] = 0xd1;
        buf.writeInt16BE(val, 1);
        return buf;
      } else {
        const buf = Buffer.alloc(5);
        buf[0] = 0xd2;
        buf.writeInt32BE(val, 1);
        return buf;
      }
    }
  }
}

export class HyperliquidSigner {
  private readonly wallet: ethers.Wallet;
  public readonly address: string;

  constructor(
    private readonly privateKey: string,
    private readonly isMainnet: boolean
  ) {
    if (!privateKey || privateKey.trim() === '') {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'Hyperliquid agent private key cannot be empty'
      );
    }
    try {
      this.wallet = new ethers.Wallet(privateKey);
      this.address = this.wallet.address.toLowerCase();
    } catch (err: any) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        `Invalid agent private key: ${err.message}`
      );
    }
  }

  /**
   * Compute the authoritative connectionId hash for L1 action signing.
   * Matches Hyperliquid SDK: keccak256(msgpack(action) + nonce (8 bytes uint64 BE) + vaultMarker)
   */
  public computeConnectionId(
    action: HyperliquidL1Action,
    nonce: number,
    vaultAddress: string | null = null,
    expiresAfter: number | null = null
  ): string {
    const actionBytes = HyperliquidMsgpackEncoder.encode(action);

    const nonceBuf = Buffer.alloc(8);
    nonceBuf.writeBigUInt64BE(BigInt(nonce), 0);

    let vaultBuf: Buffer;
    if (vaultAddress === null || vaultAddress.trim() === '') {
      vaultBuf = Buffer.from([0x00]);
    } else {
      const cleanVault = vaultAddress.toLowerCase().replace(/^0x/, '');
      if (cleanVault.length !== 40) {
        throw new HyperliquidError(
          HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
          `Invalid vault address: ${vaultAddress}`
        );
      }
      vaultBuf = Buffer.concat([Buffer.from([0x01]), Buffer.from(cleanVault, 'hex')]);
    }

    let expiresBuf = Buffer.alloc(0);
    if (expiresAfter !== null) {
      const exp = Buffer.alloc(9);
      exp[0] = 0x00;
      exp.writeBigUInt64BE(BigInt(expiresAfter), 1);
      expiresBuf = exp;
    }

    const payload = Buffer.concat([actionBytes, nonceBuf, vaultBuf, expiresBuf]);
    return ethers.keccak256(new Uint8Array(payload));
  }

  /**
   * Signs the L1 Action using EIP-712 typed data signature.
   */
  public async signL1Action(
    action: HyperliquidL1Action,
    nonce: number,
    vaultAddress: string | null = null,
    expiresAfter: number | null = null
  ): Promise<{ signature: HyperliquidSignature; connectionId: string }> {
    const connectionId = this.computeConnectionId(action, nonce, vaultAddress, expiresAfter);

    const source = this.isMainnet ? 'a' : 'b';
    const value = {
      source,
      connectionId
    };

    try {
      const rawSig = await this.wallet.signTypedData(
        HYPERLIQUID_EIP712_DOMAIN,
        HYPERLIQUID_EIP712_TYPES,
        value
      );

      const splitSig = ethers.Signature.from(rawSig);
      return {
        signature: {
          r: splitSig.r,
          s: splitSig.s,
          v: splitSig.v
        },
        connectionId
      };
    } catch (err: any) {
      throw new HyperliquidError(
        HyperliquidErrorCode.SIGNATURE_VERIFICATION_FAILED,
        `EIP-712 signing failed: ${err.message}`
      );
    }
  }

  /**
   * Verifies an EIP-712 signature and recovers the signing address.
   */
  public static verifyL1Signature(
    connectionId: string,
    signature: HyperliquidSignature,
    isMainnet: boolean
  ): string {
    const source = isMainnet ? 'a' : 'b';
    const value = {
      source,
      connectionId
    };

    const rawSig = ethers.Signature.from({
      r: signature.r,
      s: signature.s,
      v: signature.v
    }).serialized;

    return ethers.verifyTypedData(
      HYPERLIQUID_EIP712_DOMAIN,
      HYPERLIQUID_EIP712_TYPES,
      value,
      rawSig
    ).toLowerCase();
  }
}
