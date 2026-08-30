import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { KmsCustodyProvider } from '../src/services/custody/kms-custody-provider.js';
import { LocalKmsMock } from '../src/services/custody/local-kms-mock.js';
import { ethers } from 'ethers';

// Mock dependencies
import { SignCommand } from '@aws-sdk/client-kms';

describe('KmsCustodyProvider', () => {
    let mockKms: any;
    let provider: KmsCustodyProvider;
    let fakeDb: any;
    let dbMock: any;
    let deployer: ethers.Wallet;
    let kmsSpy: any;

    beforeEach(async () => {
        mockKms = new LocalKmsMock();
        kmsSpy = vi.spyOn(mockKms, 'send');

        fakeDb = {
            withdrawals: {} as any,
            hot_wallet_nonces: {} as any,
            withdrawal_transactions: [] as any[]
        };

        dbMock = {
            transaction: async (cb: any) => {
                const txClient = {
                    query: async (sql: string, params: any[] = []) => {
                        // Withdrawal Transactions Mocks
                        if (sql.includes('SELECT tx_hash, raw_signed_tx, status, network_nonce FROM withdrawal_transactions')) {
                            const found = fakeDb.withdrawal_transactions.find((t: any) => t.withdrawal_id === params[0]);
                            return found ? { rows: [found] } : { rows: [] };
                        }
                        if (sql.includes('INSERT INTO withdrawal_transactions')) {
                            fakeDb.withdrawal_transactions.push({
                                withdrawal_id: params[0],
                                network: params[1],
                                network_nonce: params[2],
                                tx_hash: params[3],
                                raw_signed_tx: params[4],
                                status: 'PENDING'
                            });
                            return { rows: [] };
                        }
                        if (sql.includes('UPDATE withdrawal_transactions SET status')) {
                            const found = fakeDb.withdrawal_transactions.find((t: any) => t.tx_hash === params[1] || t.tx_hash === params[0]);
                            if (found) {
                                found.status = sql.includes('CONFIRMED') ? 'CONFIRMED' : 'BROADCAST';
                            }
                            return { rows: [] };
                        }

                        // Hot Wallet Nonces Mocks
                        if (sql.includes('SELECT next_nonce FROM hot_wallet_nonces')) {
                            const key = params[0] + ':' + params[1];
                            const val = fakeDb.hot_wallet_nonces[key];
                            if (val !== undefined) return { rows: [{ next_nonce: val }] };
                            return { rows: [] };
                        }
                        if (sql.includes('INSERT INTO hot_wallet_nonces')) {
                            const key = params[0] + ':' + params[1];
                            fakeDb.hot_wallet_nonces[key] = params[2];
                            return { rows: [] };
                        }
                        if (sql.includes('UPDATE hot_wallet_nonces')) {
                            const key = params[0] + ':' + params[1];
                            fakeDb.hot_wallet_nonces[key]++;
                            return { rows: [] };
                        }

                        // Withdrawals Mocks
                        if (sql.includes('SELECT crypto_status')) {
                            const w = fakeDb.withdrawals[params[0]];
                            if (w) return { rows: [w] };
                            return { rows: [] };
                        }
                        if (sql.includes('SELECT id FROM withdrawals')) {
                            const w = fakeDb.withdrawals[params[0]];
                            if (w) return { rows: [{ id: params[0] }] };
                            return { rows: [] };
                        }
                        if (sql.includes('UPDATE withdrawals SET network_nonce')) {
                            const w = fakeDb.withdrawals[params[1]];
                            if (w) {
                                w.network_nonce = params[0];
                                w.crypto_status = 'SIGNING';
                            }
                            return { rows: [] };
                        }
                        if (sql.includes('UPDATE withdrawals SET provider_withdrawal_id')) {
                            const w = fakeDb.withdrawals[params[1]];
                            if (w) {
                                w.provider_withdrawal_id = params[0];
                            }
                            return { rows: [] };
                        }
                        if (sql.includes('UPDATE withdrawals SET crypto_status')) {
                            const w = fakeDb.withdrawals[params[1] || params[0]];
                            if (w) {
                                w.crypto_status = sql.includes('CONFIRMED') ? 'CONFIRMED' : 'BROADCAST';
                            }
                            return { rows: [] };
                        }
                        return { rows: [] };
                    }
                };
                return await cb(txClient);
            }
        };

        const config = {
            'ETHEREUM': {
                rpcUrl: 'http://127.0.0.1:8545',
                keyId: 'mock-key-1',
                chainId: 31337n
            }
        };

        provider = new KmsCustodyProvider(mockKms, config, dbMock);

        const jsonRpc = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
        deployer = new ethers.Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', jsonRpc);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const buildRequest = (id: string, amount: string = '1.0') => ({
        clientWithdrawalId: id,
        accountId: 'acc-1',
        asset: 'ETH',
        network: 'ETHEREUM',
        amount,
        destinationAddress: deployer.address,
        status: 'PENDING' as any,
        createdAt: new Date(),
        updatedAt: new Date()
    });

    test('A. NIST P-256 public key -> MUST FAIL', async () => {
        const badKms = {
            send: async (cmd: any) => {
                if (cmd.constructor.name === 'GetPublicKeyCommand') {
                    const res = await mockKms.send(cmd);
                    const originalDer = res.PublicKey.toString('hex');
                    // Modify the secp256k1 OID (2b8104000a) to NIST P-256 (2a8648ce3d030107) in length too
                    const nistDerHex = originalDer.replace('06052b8104000a', '06082a8648ce3d030107');
                    return { PublicKey: Buffer.from(nistDerHex, 'hex') };
                }
                return await mockKms.send(cmd);
            }
        };
        const testProvider = new KmsCustodyProvider(badKms, (provider as any).config, dbMock);
        await expect(testProvider.getHotWalletAddress('ETHEREUM')).rejects.toThrow(/NIST P-256 and other curves are not supported/);
    });

    test('C. Malformed SPKI -> MUST FAIL', async () => {
        const badKms = {
            send: async () => ({ PublicKey: Buffer.alloc(10) })
        };
        const testProvider = new KmsCustodyProvider(badKms, (provider as any).config, dbMock);
        await expect(testProvider.getHotWalletAddress('ETHEREUM')).rejects.toThrow(/Expected SEQUENCE/);
    });

    test('D/E/F/G/P. Mutated Transactions -> MUST FAIL', async () => {
        const badKms = {
            send: async (cmd: any) => {
                if (cmd.constructor.name === 'GetPublicKeyCommand') return await mockKms.send(cmd);
                const fakeDigest = ethers.randomBytes(32);
                const fakeCmd = new SignCommand({ ...cmd.input, Message: fakeDigest });
                return await mockKms.send(fakeCmd);
            }
        };
        const testProvider = new KmsCustodyProvider(badKms, (provider as any).config, dbMock);
        const req = buildRequest('test-1');
        await expect(testProvider.requestWithdrawal(req)).rejects.toThrow(/does not match expected|mutated|invalid signature/);
    });

    test('L/M/N. Unknown broadcast -> NO SECOND KMS CALL, Exact Rebroadcast', async () => {
        const req = buildRequest('test-crash-1');
        fakeDb.withdrawals['test-crash-1'] = { crypto_status: 'PENDING' };

        const hotWalletAddr = await provider.getHotWalletAddress('ETHEREUM');
        await (await deployer.sendTransaction({ to: hotWalletAddr, value: ethers.parseEther('10.0') })).wait();

        // 1. Simulate process crash immediately after persisting raw_signed_tx but before broadcast
        let kmsAttempts = 0;
        const flakeyKms = {
            send: async (cmd: any) => {
                if (cmd.constructor.name === 'GetPublicKeyCommand') return await mockKms.send(cmd);
                kmsAttempts++;
                return await mockKms.send(cmd);
            }
        };
        const jsonRpc = new ethers.JsonRpcProvider('http://127.0.0.1:8545');
        const flakeyProvider = new KmsCustodyProvider(flakeyKms, (provider as any).config, dbMock);

        // Monkeypatch broadcastTransaction to throw network timeout
        const originalBroadcast = jsonRpc.broadcastTransaction;
        let broadcastCalls = 0;
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'broadcastTransaction').mockImplementation(async (tx: string) => {
            broadcastCalls++;
            if (broadcastCalls === 1) throw new Error("Network Timeout");
            return await originalBroadcast.call(jsonRpc, tx);
        });

        await expect(flakeyProvider.requestWithdrawal(req)).rejects.toThrow(/Network Timeout/);

        // Verify state is persisted
        expect(fakeDb.withdrawal_transactions.length).toBe(1);
        const persistedTx = fakeDb.withdrawal_transactions[0];
        expect(persistedTx.status).toBe('PENDING');
        expect(kmsAttempts).toBe(1); // One signature generated

        // 2. Restart/Re-enter recovery logic (second attempt)
        await flakeyProvider.requestWithdrawal(req);

        // Verify EXACT same hash was rebroadcast
        expect(fakeDb.withdrawal_transactions[0].status).toBe('BROADCAST');
        expect(kmsAttempts).toBe(1); // NO SECOND KMS CALL!
        expect(broadcastCalls).toBe(2); // Attempted broadcast twice

        // Check local node mempool/mined
        const minedTx = await jsonRpc.getTransaction(persistedTx.tx_hash);
        expect(minedTx).not.toBeNull();
        expect(minedTx?.hash).toBe(persistedTx.tx_hash);
    });
});
