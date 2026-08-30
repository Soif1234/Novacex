import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KmsCustodyProvider } from '../src/services/custody/kms-custody-provider';
import { ethers } from 'ethers';

describe('KmsCustodyProvider getWithdrawalStatus', () => {
    let provider: KmsCustodyProvider;
    let dbMock: any;

    beforeEach(() => {
        dbMock = {
            query: vi.fn().mockImplementation((query, args) => {
                if (query.includes('FROM withdrawals')) {
                    return Promise.resolve({
                        rows: [{
                            id: 'w-1',
                            account_id: 'a-1',
                            asset: 'ETH',
                            amount: '1.0',
                            network: 'ETHEREUM',
                            destination_address: '0x123',
                            crypto_status: 'BROADCAST',
                            provider_withdrawal_id: '0x1111111111111111111111111111111111111111111111111111111111111111',
                            created_at: new Date(),
                            updated_at: new Date()
                        }]
                    });
                }
                if (query.includes('FROM withdrawal_transactions')) {
                    return Promise.resolve({
                        rows: [{
                            tx_hash: '0x1111111111111111111111111111111111111111111111111111111111111111',
                            raw_signed_tx: '0x02f874827a6980843b9aca008477359400825208941230000000000000000000000000000000000000880de0b6b3a764000080c080a01111111111111111111111111111111111111111111111111111111111111111a01111111111111111111111111111111111111111111111111111111111111111'
                        }]
                    });
                }
                return Promise.resolve({ rows: [] });
            })
        };

        const config = {
            'ETHEREUM': {
                rpcUrl: 'http://127.0.0.1:8545',
                keyId: 'mock-key-1',
                chainId: 31337n
            }
        };
        provider = new KmsCustodyProvider({} as any, config, dbMock);

        // Mock getHotWalletAddress
        vi.spyOn(provider, 'getHotWalletAddress').mockResolvedValue('0x999');
    });

    it('J. KMS getWithdrawalStatus pending', async () => {
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValueOnce(null);
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransaction').mockResolvedValueOnce({ hash: '0x111' } as any);

        const res = await provider.getWithdrawalStatus('w-1');
        expect(res.status).toBe('PENDING');
    });

    it('K. KMS getWithdrawalStatus mined (CONFIRMED)', async () => {
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValueOnce({ status: 1 } as any);

        const res = await provider.getWithdrawalStatus('w-1');
        expect(res.status).toBe('CONFIRMED');
    });

    it('L. KMS getWithdrawalStatus not found/reverted (FAILED)', async () => {
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValueOnce({ status: 0 } as any);

        const res = await provider.getWithdrawalStatus('w-1');
        expect(res.status).toBe('FAILED');
    });

    it('L2. KMS getWithdrawalStatus not found in mempool (PENDING/UNRESOLVED)', async () => {
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockResolvedValueOnce(null);
        vi.spyOn(ethers.JsonRpcProvider.prototype, 'getTransaction').mockResolvedValueOnce(null);

        const res = await provider.getWithdrawalStatus('w-1');
        expect(res.status).toBe('PENDING'); // Should not map missing to FAILED!
    });
});
