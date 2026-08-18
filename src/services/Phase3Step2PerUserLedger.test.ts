import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LedgerService, ledgerService, DEFAULT_ACCOUNT_ID } from './wallet/LedgerService';
import { DemoLedger, demoLedger } from './ledger';
import { internalTransferService } from './wallet/InternalTransferService';
import { demoTransactionService } from './wallet/DemoTransactionService';
import { transactionService } from './transactions/TransactionService';
import { FuturesOrderService } from './futures/FuturesOrderService';
import { OrderService } from './OrderService';
import { tradeService } from './TradeService';
import { walletService } from './wallet/WalletService';
import { futuresMarketService } from './futures/FuturesMarketService';

describe('Phase 3 Step 2: Canonical Per-User Ledger & Balance Isolation', () => {
  beforeEach(() => {
    vi.spyOn(futuresMarketService, 'getMarket').mockResolvedValue({
      symbol: 'BTCUSDT',
      lastPrice: '50000',
      markPrice: '50000',
      indexPrice: '50000',
      maintenanceMarginRate: '0.005',
      minimumQuantity: '0.001',
      maximumLeverage: 125,
      makerFee: '0.0002',
      takerFee: '0.0004'
    } as any);

    sessionStorage.clear();
    localStorage.clear();
    ledgerService.reset();
  });

  it('A & B. User A and User B start with independent default demo balances', () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    expect(ledgerService.getBalance('USDT', userA)).toBe('10000');
    expect(ledgerService.getBalance('FUTURES_USDT', userA)).toBe('0');

    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
    expect(ledgerService.getBalance('FUTURES_USDT', userB)).toBe('0');
  });

  it('C & D. User A credits 500 USDT -> User B USDT remains unchanged', () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    ledgerService.credit('USDT', '500', 'Bonus credit', 'OTHER', 'cred-1', userA);

    expect(ledgerService.getBalance('USDT', userA)).toBe('10500');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
  });

  it('E & F. User A debits 200 USDT -> User B remains unchanged', () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    ledgerService.debit('USDT', '200', 'Fee debit', 'TRADING_FEE', 'deb-1', userA);

    expect(ledgerService.getBalance('USDT', userA)).toBe('9800');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
  });

  it('G & H. User A transfers USDT -> FUTURES_USDT -> User B remains unchanged', async () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    await internalTransferService.createTransfer('USDT', '1500', 'SPOT', 'FUTURES', userA);

    // User A should have 8500 Spot USDT and 1500 Futures USDT
    expect(ledgerService.getBalance('USDT', userA)).toBe('8500');
    expect(ledgerService.getBalance('FUTURES_USDT', userA)).toBe('1500');

    // User B should remain untouched
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
    expect(ledgerService.getBalance('FUTURES_USDT', userB)).toBe('0');
  }, 15000);

  it('I, J & K. User A creates Futures LIMIT order -> Only User A FUTURES_USDT is reserved -> User B remains unchanged', async () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    // Fund user A and user B futures wallets
    ledgerService.credit('FUTURES_USDT', '5000', 'Init futures', 'TRANSFER', 'init-a', userA);
    ledgerService.credit('FUTURES_USDT', '5000', 'Init futures', 'TRANSFER', 'init-b', userB);

    const futuresService = new FuturesOrderService(demoLedger, false);

    // Place LIMIT order for User A (1 BTC at 40000 with 10x leverage = 4000 USDT required margin)
    const orderA = await futuresService.placeOrder({
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      positionSide: 'LONG',
      type: 'LIMIT',
      price: '40000',
      quantity: '1',
      leverage: 10,
      marginMode: 'ISOLATED'
    });

    expect(orderA.status).toBe('PENDING');
    // User A margin reserved: 5000 - 4000 = 1000
    expect(ledgerService.getBalance('FUTURES_USDT', userA)).toBe('1000');
    // User B remains full 5000
    expect(ledgerService.getBalance('FUTURES_USDT', userB)).toBe('5000');

    // L & M. User A cancels the order -> Only User A receives margin release
    await futuresService.cancelOrder(orderA.id);

    expect(ledgerService.getBalance('FUTURES_USDT', userA)).toBe('5000');
    expect(ledgerService.getBalance('FUTURES_USDT', userB)).toBe('5000');
  });

  it('N & O. User A makes demo deposit -> User B does not receive it', async () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    await demoTransactionService.createDeposit('USDT', '3000', userA);

    expect(ledgerService.getBalance('USDT', userA)).toBe('13000');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
  });

  it('P & Q. User A withdraws -> User B remains unchanged', async () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    const userABalance = ledgerService.getBalance('USDT', userA);
    await demoTransactionService.createWithdrawal('USDT', '1000', 'External address', userABalance, userA);

    expect(ledgerService.getBalance('USDT', userA)).toBe('9000');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
  });

  it('R & S. User A transaction history contains only User A entries -> User B cannot see User A entries', () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    ledgerService.credit('USDT', '500', 'Deposit Alice', 'DEPOSIT', 'tx-a-1', userA);
    ledgerService.credit('USDT', '300', 'Deposit Bob', 'DEPOSIT', 'tx-b-1', userB);

    const historyA = transactionService.getTransactions(userA);
    const historyB = transactionService.getTransactions(userB);

    expect(historyA.some(t => t.description === 'Deposit Alice')).toBe(true);
    expect(historyA.some(t => t.description === 'Deposit Bob')).toBe(false);

    expect(historyB.some(t => t.description === 'Deposit Bob')).toBe(true);
    expect(historyB.some(t => t.description === 'Deposit Alice')).toBe(false);
  });

  it('T. Same referenceId used by User A and User B does not collide', () => {
    const userA = 'user-alice-101';
    const userB = 'user-bob-202';

    const sharedRef = 'payment-ref-12345';

    ledgerService.credit('USDT', '250', 'Payment', 'OTHER', sharedRef, userA);
    ledgerService.credit('USDT', '250', 'Payment', 'OTHER', sharedRef, userB);

    expect(ledgerService.getBalance('USDT', userA)).toBe('10250');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10250');
  });

  it('U. Duplicate referenceId for the SAME account remains idempotent', () => {
    const userA = 'user-alice-101';
    const ref = 'idempotent-ref-999';

    ledgerService.credit('USDT', '300', 'First attempt', 'OTHER', ref, userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10300');

    // Duplicate credit with same referenceId should be ignored
    ledgerService.credit('USDT', '300', 'Second attempt', 'OTHER', ref, userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10300');

    // Duplicate debit with same referenceId
    const debitRef = 'debit-ref-888';
    ledgerService.debit('USDT', '100', 'Debit 1', 'OTHER', debitRef, userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10200');

    ledgerService.debit('USDT', '100', 'Debit 2', 'OTHER', debitRef, userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10200');
  });

  it('V. DemoLedger facade and LedgerService remain balance-consistent across users', () => {
    const userA = 'user-alice-101';

    expect(demoLedger.getBalance('USDT', userA)).toBe(ledgerService.getBalance('USDT', userA));

    demoLedger.credit('USDT', '777', 'Facade credit', 'OTHER', 'facade-1', userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10777');
    expect(demoLedger.getBalance('USDT', userA)).toBe('10777');

    demoLedger.debit('USDT', '77', 'Facade debit', 'OTHER', 'facade-2', userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10700');
    expect(demoLedger.getBalance('USDT', userA)).toBe('10700');
  });

  it('W. Spot and Futures balances remain isolated per user', () => {
    const userA = 'user-alice-101';

    // Debit FUTURES_USDT should not affect Spot USDT
    ledgerService.credit('FUTURES_USDT', '2000', 'Init futures', 'TRANSFER', 'fut-init', userA);
    ledgerService.debit('FUTURES_USDT', '500', 'Margin', 'MARGIN', 'fut-margin', userA);

    expect(ledgerService.getBalance('USDT', userA)).toBe('10000');
    expect(ledgerService.getBalance('FUTURES_USDT', userA)).toBe('1500');

    // Debit Spot USDT should not affect FUTURES_USDT
    ledgerService.debit('USDT', '1000', 'Spot order lock', 'OTHER', 'spot-lock', userA);

    expect(ledgerService.getBalance('USDT', userA)).toBe('9000');
    expect(ledgerService.getBalance('FUTURES_USDT', userA)).toBe('1500');
  });

  describe('Legacy Storage Migration', () => {
    it('migrates legacy flat global balance strictly to demo-user-1 and does not copy to other users', () => {
      sessionStorage.clear();
      // Set old legacy flat dictionary
      sessionStorage.setItem('nova_ledger_balances', JSON.stringify({
        USDT: '45000',
        FUTURES_USDT: '12000',
        BTC: '2.5'
      }));

      // Initialize a new LedgerService instance with persistence
      const migratedLedger = new LedgerService(true);

      // Default demo-user-1 receives migrated balances
      expect(migratedLedger.getBalance('USDT', 'demo-user-1')).toBe('45000');
      expect(migratedLedger.getBalance('FUTURES_USDT', 'demo-user-1')).toBe('12000');
      expect(migratedLedger.getBalance('BTC', 'demo-user-1')).toBe('2.5');

      // Another user (e.g. user-2) receives their own clean default demo balances, NOT legacy balances
      expect(migratedLedger.getBalance('USDT', 'user-bob-2')).toBe('10000');
      expect(migratedLedger.getBalance('FUTURES_USDT', 'user-bob-2')).toBe('0');
      expect(migratedLedger.getBalance('BTC', 'user-bob-2')).toBe('0');
    });

    it('repeated initialization does not duplicate balances or corrupt per-user state', () => {
      sessionStorage.clear();
      const instance1 = new LedgerService(true);
      instance1.credit('USDT', '5000', 'Initial credit', 'OTHER', 'ref-init-1', 'user-charlie');
      expect(instance1.getBalance('USDT', 'user-charlie')).toBe('15000');

      // Re-instantiate from persisted storage
      const instance2 = new LedgerService(true);
      expect(instance2.getBalance('USDT', 'user-charlie')).toBe('15000');

      // Re-instantiate a third time
      const instance3 = new LedgerService(true);
      expect(instance3.getBalance('USDT', 'user-charlie')).toBe('15000');
      expect(instance3.getBalance('USDT', 'demo-user-1')).toBe('10000');
    });
  });
});
