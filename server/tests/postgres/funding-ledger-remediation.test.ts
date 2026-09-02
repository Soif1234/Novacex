import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FuturesFundingService } from '../../src/services/futures/funding.service';
import { ledgerService } from '../../src/services/ledger/ledger.service';
import { marketDataService } from '../../src/services/market/market.service';
import { INSURANCE_FUND_ACCOUNT_ID } from '../../src/services/futures/insurance-fund.service';
import { db } from '../../src/config/database';

vi.mock('../../src/services/ledger/ledger.service', () => ({
  ledgerService: {
    postTransaction: vi.fn(),
    reserve: vi.fn(),
    release: vi.fn()
  }
}));

vi.mock('../../src/services/market/market.service', () => ({
  marketDataService: {
    getMarkPrice: vi.fn().mockResolvedValue({ price: '100' }),
    getIndexPrice: vi.fn().mockResolvedValue('100')
  }
}));

vi.mock('../../src/config/database', () => ({
  db: {
    transaction: vi.fn(),
    query: vi.fn()
  }
}));

describe('P0-3 Funding Ledger Remediation', () => {
    let fundingService: FuturesFundingService;

    beforeEach(() => {
        fundingService = new FuturesFundingService();
        fundingService.setFundingRate('0.001');

        (db.transaction as any).mockImplementation(async (cb: any) => {
            const txClient = {
                query: vi.fn().mockImplementation(async (query: string, params: any[]) => {
                    if (query.includes('FROM futures_positions')) {
                        return { rows: [
                            { id: 'pos1', account_id: 'acc1', symbol: 'BTC_USDT', side: 'LONG', quantity: '1', entry_price: '100', collateral_asset: 'USDT', status: 'OPEN', margin_type: 'ISOLATED' },
                            { id: 'pos2', account_id: 'acc2', symbol: 'BTC_USDT', side: 'SHORT', quantity: '1', entry_price: '100', collateral_asset: 'USDT', status: 'OPEN', margin_type: 'ISOLATED' }
                        ]};
                    }
                    if (query.includes('wallet_balances')) {
                        return { rows: [{ available_balance: '100' }] };
                    }
                    return { rows: [] };
                })
            };
            return cb(txClient);
        });
    });

    it('should balance every single user funding leg directly with the Insurance Fund', async () => {
        await fundingService.settleFundingInterval('BTC_USDT', Date.now());

        const calls = (ledgerService.postTransaction as any).mock.calls;

        const longCall = calls.find((c: any) => c[0].entries.some((e: any) => e.accountId === 'acc1'));
        expect(longCall).toBeDefined();
        expect(longCall[0].entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: 'acc1', direction: 'DEBIT' }),
            expect.objectContaining({ accountId: INSURANCE_FUND_ACCOUNT_ID, direction: 'CREDIT' })
        ]));

        const shortCall = calls.find((c: any) => c[0].entries.some((e: any) => e.accountId === 'acc2'));
        expect(shortCall).toBeDefined();
        expect(shortCall[0].entries).toEqual(expect.arrayContaining([
            expect.objectContaining({ accountId: 'acc2', direction: 'CREDIT' }),
            expect.objectContaining({ accountId: INSURANCE_FUND_ACCOUNT_ID, direction: 'DEBIT' })
        ]));
    });
});
