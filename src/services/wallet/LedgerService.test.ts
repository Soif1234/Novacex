import { describe, it, expect, beforeEach } from 'vitest';
import { LedgerService, LedgerEntryType } from './LedgerService';

describe('LedgerService', () => {
  let service: LedgerService;

  beforeEach(() => {
    service = new LedgerService(false);
  });

  it('should add entry and deduplicate by referenceId', () => {
    service.addEntry({
      type: 'DEPOSIT',
      asset: 'USDT',
      amount: '100',
      balanceBefore: '1000',
      balanceAfter: '1100',
      wallet: 'SPOT',
      direction: 'CREDIT',
      status: 'COMPLETED',
      referenceId: 'ref-123',
      description: 'Test Deposit'
    });

    expect(service.getEntries().length).toBe(1);

    // Add duplicate
    service.addEntry({
      type: 'DEPOSIT',
      asset: 'USDT',
      amount: '100',
      balanceBefore: '1000',
      balanceAfter: '1100',
      wallet: 'SPOT',
      direction: 'CREDIT',
      status: 'COMPLETED',
      referenceId: 'ref-123',
      description: 'Test Deposit'
    });

    expect(service.getEntries().length).toBe(1); // Still 1
  });

  it('should query correctly', () => {
    service.addEntry({
      type: 'DEPOSIT',
      asset: 'USDT',
      amount: '100',
      balanceBefore: '1000',
      balanceAfter: '1100',
      wallet: 'SPOT',
      direction: 'CREDIT',
      status: 'COMPLETED',
      referenceId: 'ref-123',
      description: 'Test Deposit'
    });

    service.addEntry({
      type: 'WITHDRAWAL',
      asset: 'BTC',
      amount: '1',
      balanceBefore: '5',
      balanceAfter: '4',
      wallet: 'FUTURES',
      direction: 'DEBIT',
      status: 'COMPLETED',
      referenceId: 'ref-456',
      description: 'Test Withdraw'
    });

    expect(service.getEntriesByAsset('BTC').length).toBe(1);
    expect(service.getEntriesByWallet('SPOT').length).toBe(1);
    expect(service.getEntriesByType('DEPOSIT').length).toBe(1);
  });
});
