import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withdrawalProcessingWorker } from '../src/workers/WithdrawalProcessingWorker';
import { withdrawalStatusWorker } from '../src/workers/WithdrawalStatusWorker';
import { withdrawalService } from '../src/services/wallet/withdrawal.service';
import { custodyService } from '../src/services/custody/custody.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';

vi.mock('../src/services/wallet/withdrawal.service');
vi.mock('../src/services/custody/custody.service');
vi.mock('../src/services/system/circuit-breaker.service');
vi.mock('../src/config/env', () => ({
  env: {
    CRYPTO_WITHDRAWALS_ENABLED: true
  }
}));

describe('Withdrawal Workers Integration', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(circuitBreakerService.isSubsystemOperational).mockResolvedValue({ operational: true });
        vi.mocked(withdrawalService.claimStuckWithdrawals).mockResolvedValue([]);
    });

    it('A. approved withdrawal reaches CustodyService', async () => {
        vi.mocked(withdrawalService.claimApprovedWithdrawals).mockResolvedValue([{
            id: 'w-1', accountId: 'a-1', asset: 'ETH', network: 'ETHEREUM', amount: '1', destinationAddress: '0x1', status: 'PENDING', cryptoStatus: 'SUBMITTING', createdAt: new Date(), updatedAt: new Date()
        } as any]);
        vi.mocked(custodyService.requestWithdrawal).mockResolvedValue({ providerWithdrawalId: 'tx-1', status: 'BROADCAST' } as any);
        vi.mocked(custodyService.getProviderId).mockReturnValue('mock');

        await (withdrawalProcessingWorker as any).execute();

        expect(custodyService.requestWithdrawal).toHaveBeenCalledTimes(1);
        expect(withdrawalService.markAsSubmitted).toHaveBeenCalledWith('w-1', 'mock', 'tx-1');
    });

    it('B. unapproved withdrawal never reaches CustodyService', async () => {
        vi.mocked(withdrawalService.claimApprovedWithdrawals).mockResolvedValue([]);

        await (withdrawalProcessingWorker as any).execute();

        expect(custodyService.requestWithdrawal).not.toHaveBeenCalled();
    });

    it('C. temporary RPC absence -> no refund', async () => {
        vi.mocked(withdrawalService.getActiveCustodyWithdrawals).mockResolvedValue([{
            id: 'w-1', status: 'PENDING', cryptoStatus: 'SUBMITTED'
        } as any]);
        vi.mocked(custodyService.getWithdrawalStatus).mockResolvedValue({ status: 'PENDING' } as any);

        await (withdrawalStatusWorker as any).execute();

        expect(withdrawalService.failWithdrawal).not.toHaveBeenCalled();
        expect(withdrawalService.completeWithdrawal).not.toHaveBeenCalled();
    });

    it('F. KMS failure AFTER nonce reservation does not revert to APPROVED (nonce preserved as SIGNING)', async () => {
        vi.mocked(withdrawalService.claimApprovedWithdrawals).mockResolvedValue([{
            id: 'w-1', accountId: 'a-1', asset: 'ETH', network: 'ETHEREUM', amount: '1', destinationAddress: '0x1', status: 'PENDING', cryptoStatus: 'SUBMITTING', createdAt: new Date(), updatedAt: new Date()
        } as any]);
        vi.mocked(custodyService.requestWithdrawal).mockRejectedValue(new Error('KMS error'));
        // Live custody state at failure time: the provider already reserved
        // nonce 7 (persisted atomically in withdrawals.network_nonce). The
        // claim had normalized the row to SUBMITTING before the attempt.
        vi.mocked(withdrawalService.getCryptoState).mockResolvedValue({ crypto_status: 'SUBMITTING', network_nonce: 7 });

        await (withdrawalProcessingWorker as any).execute();

        expect(custodyService.requestWithdrawal).toHaveBeenCalledTimes(1);
        // Corrected semantics (6E-4C-2): reverting to APPROVED would make the
        // next attempt allocate a FRESH nonce, burning nonce 7 permanently.
        expect(withdrawalService.updateCryptoStatus).toHaveBeenCalledWith('w-1', 'SIGNING');
        expect(withdrawalService.updateCryptoStatus).not.toHaveBeenCalledWith('w-1', 'APPROVED');
        expect(withdrawalService.markAsSubmitted).not.toHaveBeenCalled();
    });

    it('F2. pre-reservation local failure (no nonce reserved) safely reverts to APPROVED', async () => {
        vi.mocked(withdrawalService.claimApprovedWithdrawals).mockResolvedValue([{
            id: 'w-1', accountId: 'a-1', asset: 'ETH', network: 'ETHEREUM', amount: '1', destinationAddress: '0x1', status: 'PENDING', cryptoStatus: 'SUBMITTING', createdAt: new Date(), updatedAt: new Date()
        } as any]);
        vi.mocked(custodyService.requestWithdrawal).mockRejectedValue(new Error('Invalid destination address'));
        // Failure happened BEFORE any reservation: no nonce on the row.
        vi.mocked(withdrawalService.getCryptoState).mockResolvedValue({ crypto_status: 'SUBMITTING', network_nonce: null });

        await (withdrawalProcessingWorker as any).execute();

        expect(withdrawalService.updateCryptoStatus).toHaveBeenCalledWith('w-1', 'APPROVED');
    });

    it('G. SIGNING survives process restart (stuck recovery)', async () => {
        vi.mocked(withdrawalService.claimApprovedWithdrawals).mockResolvedValue([]);
        vi.mocked(withdrawalService.claimStuckWithdrawals).mockResolvedValue([{
            id: 'w-1', accountId: 'a-1', asset: 'ETH', network: 'ETHEREUM', amount: '1', destinationAddress: '0x1', status: 'PENDING', cryptoStatus: 'SUBMITTING', createdAt: new Date(), updatedAt: new Date()
        } as any]);
        vi.mocked(custodyService.requestWithdrawal).mockResolvedValue({ providerWithdrawalId: 'tx-1', status: 'BROADCAST' } as any);
        vi.mocked(custodyService.getProviderId).mockReturnValue('mock');

        await (withdrawalProcessingWorker as any).execute();

        expect(custodyService.requestWithdrawal).toHaveBeenCalledTimes(1);
        expect(withdrawalService.markAsSubmitted).toHaveBeenCalledWith('w-1', 'mock', 'tx-1');
    });

    it('I. confirmed transaction completes correctly in status worker', async () => {
        vi.mocked(withdrawalService.getActiveCustodyWithdrawals).mockResolvedValue([{
            id: 'w-1', status: 'PENDING', cryptoStatus: 'SUBMITTED'
        } as any]);
        vi.mocked(custodyService.getWithdrawalStatus).mockResolvedValue({ status: 'CONFIRMED', providerReference: 'tx-1' } as any);

        await (withdrawalStatusWorker as any).execute();

        expect(withdrawalService.completeWithdrawal).toHaveBeenCalledWith('w-1', 'tx-1');
    });

    it('J. failed/reverted transaction maps correctly in status worker', async () => {
        vi.mocked(withdrawalService.getActiveCustodyWithdrawals).mockResolvedValue([{
            id: 'w-1', status: 'PENDING', cryptoStatus: 'SUBMITTED'
        } as any]);
        vi.mocked(custodyService.getWithdrawalStatus).mockResolvedValue({ status: 'FAILED' } as any);

        await (withdrawalStatusWorker as any).execute();

        expect(withdrawalService.failWithdrawal).toHaveBeenCalledWith('w-1', 'Custody provider rejection');
    });
});
