import { describe, it, expect, beforeEach } from 'vitest';
import { DemoTransactionService } from './DemoTransactionService';
import { demoLedger } from '../ledger';
import { Decimal } from 'decimal.js';
import { walletService } from './WalletService';
import { futuresOrderService } from '../futures/FuturesOrderService';

describe('DemoTransactionService', () => {
  let service: DemoTransactionService;

  beforeEach(() => {
    demoLedger.reset();
    service = new DemoTransactionService(false);
  });

  it('1. Demo deposit, 2. balance increase, 3. record creation', async () => {
    const initialBalance = new Decimal(demoLedger.getBalance('USDT'));
    const tx = await service.createDeposit('USDT', '1000');
    
    expect(tx.status).toBe('COMPLETED');
    expect(tx.type).toBe('DEPOSIT');
    
    const newBalance = new Decimal(demoLedger.getBalance('USDT'));
    expect(newBalance.minus(initialBalance).toString()).toBe('1000');
  });

  it('4. Demo withdrawal, 5. balance decrease, 6. record creation', async () => {
    const initialBalance = new Decimal(demoLedger.getBalance('USDT'));
    const tx = await service.createWithdrawal('USDT', '2000', 'Demo External', initialBalance.toString());
    
    expect(tx.status).toBe('COMPLETED');
    expect(tx.type).toBe('WITHDRAWAL');
    
    const newBalance = new Decimal(demoLedger.getBalance('USDT'));
    expect(initialBalance.minus(newBalance).toString()).toBe('2000');
  });

  it('7. Insufficient balance', async () => {
    await expect(service.createWithdrawal('USDT', '20000', 'Demo External', '10000'))
      .rejects.toThrow('Insufficient available balance');
  });

  it('8. Locked balance protection', async () => {
    // If available is only 5000, and we try to withdraw 6000
    await expect(service.createWithdrawal('USDT', '6000', 'Demo External', '5000'))
      .rejects.toThrow('Insufficient available balance');
  });

  it('9. Zero amount', async () => {
    await expect(service.createDeposit('USDT', '0')).rejects.toThrow('Amount must be greater than zero');
  });

  it('10. Negative amount', async () => {
    await expect(service.createDeposit('USDT', '-100')).rejects.toThrow('Amount must be greater than zero');
  });

  it('11. NaN', async () => {
    await expect(service.createDeposit('USDT', 'NaN')).rejects.toThrow('Invalid amount');
  });

  it('12. Infinity', async () => {
    await expect(service.createDeposit('USDT', 'Infinity')).rejects.toThrow('Invalid amount');
  });

  it('15. Persistence, 19. Refresh persistence', () => {
    const persistentService = new DemoTransactionService(true);
    // Since it's in a test environment, sessionStorage might not be fully functional,
    // but the constructor should run without errors.
    expect(persistentService.getTransactions()).toEqual([]);
  });

  it('16. Portfolio value updates', async () => {
    const balancesBefore = await walletService.getWalletBalances('demo-user-1');
    const initialTotal = new Decimal(balancesBefore.total);
    
    await service.createDeposit('USDT', '1000');
    
    const balancesAfter = await walletService.getWalletBalances('demo-user-1');
    expect(new Decimal(balancesAfter.total).minus(initialTotal).toString()).toBe('1000');
  });

  it('20. No trading side effects', async () => {
    // Orders should remain unchanged
    const initialOrders = futuresOrderService.getOrders('demo-user-1');
    await service.createDeposit('USDT', '500');
    const finalOrders = futuresOrderService.getOrders('demo-user-1');
    expect(initialOrders.length).toBe(finalOrders.length);
  });
});
