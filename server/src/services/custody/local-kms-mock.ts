import { ethers } from 'ethers';
import crypto from 'crypto';

export class LocalKmsMock {
    private wallet: ethers.Wallet;

    constructor(privateKey?: string) {
        // Use a deterministic key if none provided
        this.wallet = new ethers.Wallet(privateKey || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
    }

    public async getEthereumAddress(): Promise<string> {
        return this.wallet.address;
    }

    public async send(command: any): Promise<any> {
        const cmdName = command.constructor.name;

        if (cmdName === 'GetPublicKeyCommand') {
            // Reconstruct an SPKI DER for secp256k1
            const uncompressedKey = this.wallet.signingKey.publicKey; // 0x04... 65 bytes
            const keyBytes = Buffer.from(uncompressedKey.slice(2), 'hex');

            // ASN.1 SPKI header for secp256k1:
            // SEQUENCE (88 bytes total)
            //   SEQUENCE (algorithm) (19 bytes)
            //     OBJECT IDENTIFIER ecPublicKey (1.2.840.10045.2.1)
            //     OBJECT IDENTIFIER secp256k1 (1.3.132.0.10)
            //   BIT STRING (66 bytes: 0x00 + 65 bytes key)
            const spkiHeader = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
            const der = Buffer.concat([spkiHeader, keyBytes]);

            return {
                PublicKey: der
            };
        }

        if (cmdName === 'SignCommand') {
            const digest = Buffer.from(command.input.Message);
            const sig = this.wallet.signingKey.sign('0x' + digest.toString('hex'));

            // Construct DER signature
            const rBuffer = Buffer.from(sig.r.slice(2), 'hex');
            const sBuffer = Buffer.from(sig.s.slice(2), 'hex');

            // ASN.1 requires positive integers to start with 0x00 if highest bit is 1
            const rPrefix = rBuffer[0] >= 0x80 ? Buffer.from([0x00]) : Buffer.alloc(0);
            const sPrefix = sBuffer[0] >= 0x80 ? Buffer.from([0x00]) : Buffer.alloc(0);

            const rFinal = Buffer.concat([rPrefix, rBuffer]);
            const sFinal = Buffer.concat([sPrefix, sBuffer]);

            const rBlock = Buffer.concat([Buffer.from([0x02, rFinal.length]), rFinal]);
            const sBlock = Buffer.concat([Buffer.from([0x02, sFinal.length]), sFinal]);

            const der = Buffer.concat([Buffer.from([0x30, rBlock.length + sBlock.length]), rBlock, sBlock]);

            return {
                Signature: der
            };
        }

        throw new Error(`Unsupported MockKMS Command: ${cmdName}`);
    }
}