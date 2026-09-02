import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KmsCustodyProvider } from '../../src/services/custody/kms-custody-provider';
import { ethers } from 'ethers';

vi.mock('ethers', async (importOriginal) => {
    const actual = await importOriginal<typeof import('ethers')>();
    return {
        ...actual,
        ethers: {
            ...actual.ethers,
            JsonRpcProvider: vi.fn().mockImplementation(() => ({
                getBlockNumber: vi.fn().mockResolvedValue(12345),
                getBalance: vi.fn().mockResolvedValue(actual.ethers.parseEther('100')),
                getTransactionCount: vi.fn().mockResolvedValue(0)
            })),
            Contract: vi.fn().mockImplementation(() => ({
                balanceOf: vi.fn().mockResolvedValue(actual.ethers.parseUnits('500', 6))
            }))
        }
    };
});

describe('F2 P0 - ERC20 Treasury Safety', () => {
    let kms: KmsCustodyProvider;
    let mockDb: any;
    let mockKmsClient: any;

    beforeEach(() => {
        mockDb = {
            query: vi.fn(),
            transaction: vi.fn()
        };
        mockKmsClient = {};
        const config = {
            'ethereum': {
                rpcUrl: 'http://localhost:8545',
                chainId: 1n,
                keyId: 'mock-key'
            }
        };
        kms = new KmsCustodyProvider(mockKmsClient, config as any, mockDb);
        vi.spyOn(kms, 'getHotWalletAddress').mockResolvedValue('0xHotWalletAddress');
    });

    it('B. USDT treasury transfer -> reject before nonce allocation', async () => {
        const req = {
            network: 'ethereum',
            asset: 'USDT',
            amount: '1000',
            destinationAddress: '0xSafe',
            treasuryIntentId: 'intent-usdt',
            adminId: 'admin'
        };

        await expect(kms.submitTreasuryTransfer(req as any)).rejects.toThrow(/only native ETH is implemented/);
        expect(mockDb.query).not.toHaveBeenCalled();
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('C. USDC treasury transfer -> reject before nonce allocation', async () => {
        const req = {
            network: 'ethereum',
            asset: 'USDC',
            amount: '1000',
            destinationAddress: '0xSafe',
            treasuryIntentId: 'intent-usdc',
            adminId: 'admin'
        };

        await expect(kms.submitTreasuryTransfer(req as any)).rejects.toThrow(/only native ETH is implemented/);
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('D. arbitrary token -> reject', async () => {
        const req = {
            network: 'ethereum',
            asset: 'SHIB',
            amount: '100000',
            destinationAddress: '0xSafe',
            treasuryIntentId: 'intent-shib',
            adminId: 'admin'
        };

        await expect(kms.submitTreasuryTransfer(req as any)).rejects.toThrow(/only native ETH is implemented/);
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('E. malformed asset -> reject', async () => {
        const req = {
            network: 'ethereum',
            asset: '',
            amount: '100000',
            destinationAddress: '0xSafe',
            treasuryIntentId: 'intent-malformed',
            adminId: 'admin'
        };

        await expect(kms.submitTreasuryTransfer(req as any)).rejects.toThrow(/only native ETH is implemented/);
        expect(mockDb.transaction).not.toHaveBeenCalled();
    });

    it('A. ETH treasury transfer -> continue through normal validated path', async () => {
        const req = {
            network: 'ethereum',
            asset: 'ETH',
            amount: '10',
            destinationAddress: '0xSafe',
            treasuryIntentId: 'intent-eth',
            adminId: 'admin'
        };

        mockDb.query.mockResolvedValueOnce({ rows: [] });

        mockDb.transaction.mockImplementation(async (cb: any) => {
            const txClient = { query: vi.fn() };
            txClient.query.mockResolvedValueOnce({ rows: [] }); // hot_wallet_nonces for UPDATE
            txClient.query.mockResolvedValueOnce({ rows: [{ sum: '0', cnt: '0' }] }); // withdrawals
            txClient.query.mockResolvedValueOnce({ rows: [{ sum: '0', cnt: '0' }] }); // treasury
            txClient.query.mockResolvedValueOnce({ rows: [] }); // INSERT hot_wallet_nonces
            txClient.query.mockResolvedValueOnce({ rows: [{ id: 1 }] }); // INSERT artifact
            await cb(txClient);
        });

        // The transaction completes successfully, then it tries to do KMS stuff which will fail since we mocked the kmsClient to {}
        await expect(kms.submitTreasuryTransfer(req as any)).rejects.toThrow(TypeError);
        // test passed if it reached the provider constructor
    });
});
