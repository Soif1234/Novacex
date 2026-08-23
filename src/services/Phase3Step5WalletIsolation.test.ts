import { describe, it, expect, beforeEach, vi } from 'vitest';
import { LedgerService, ledgerService, DEFAULT_ACCOUNT_ID } from './wallet/LedgerService';
import { demoLedger } from './ledger';
import { walletService } from './wallet/WalletService';
import { orderService } from './OrderService';
import { transactionService } from './transactions/TransactionService';
import { internalTransferService } from './wallet/InternalTransferService';
import { demoTransactionService } from './wallet/DemoTransactionService';

describe.skip('Phase 3 Step 5 — Wallet & Transaction Authority Remediation', () => {
  const userA = 'user-alice-step5';
  const userB = 'user-bob-step5';

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: true, json: async () => [] } as any);
    sessionStorage.clear();
    localStorage.clear();
    ledgerService.reset();
    orderService['orders'] = [];
  });

  it('1. Home account isolation: User A and User B have independent balances', () => {
    // User A credits 5,000 USDT
    ledgerService.credit('USDT', '5000', 'Bonus A', 'OTHER', 'bonus-a', userA);

    const balanceA = ledgerService.getBalance('USDT', userA);
    const balanceB = ledgerService.getBalance('USDT', userB);
    const defaultBalance = ledgerService.getBalance('USDT', DEFAULT_ACCOUNT_ID);

    expect(balanceA).toBe('15000');
    expect(balanceB).toBe('10000');
    expect(defaultBalance).toBe('10000');
    expect(balanceA).not.toBe(balanceB);
  });

  it('2. Fresh default balance for new users: User A mutating balance does not affect newly created User B', () => {
    // 1. User A modifies balance extensively (deposits, trades)
    ledgerService.credit('USDT', '90000', 'Deposit A', 'DEPOSIT', 'dep-a', userA);
    ledgerService.credit('BTC', '5', 'Trade A', 'OTHER', 'trade-a', userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('100000');
    expect(ledgerService.getBalance('BTC', userA)).toBe('5');

    // Also mutate default account
    ledgerService.credit('USDT', '40000', 'Deposit Default', 'DEPOSIT', 'dep-def', DEFAULT_ACCOUNT_ID);
    expect(ledgerService.getBalance('USDT', DEFAULT_ACCOUNT_ID)).toBe('50000');

    // 2. User B is accessed for the very first time afterward
    const balancesB = ledgerService.getAllBalances(userB);
    expect(balancesB['USDT']).toBe('10000');
    expect(balancesB['FUTURES_USDT']).toBe('0');
    expect(balancesB['BTC']).toBe('0');
    expect(balancesB['ETH']).toBe('0');

    // User A remains 100,000 USDT and 5 BTC
    expect(ledgerService.getBalance('USDT', userA)).toBe('100000');
    expect(ledgerService.getBalance('BTC', userA)).toBe('5');
  });

  it('3 & 4. User-specific credit and debit: only target user balance is modified', () => {
    // Credit User A
    ledgerService.credit('USDT', '3000', 'Credit Alice', 'DEPOSIT', 'cred-alice', userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('13000');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');

    // Debit User A
    ledgerService.debit('USDT', '2000', 'Debit Alice', 'WITHDRAWAL', 'deb-alice', userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('11000');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');

    // Debit User B
    ledgerService.debit('USDT', '1000', 'Debit Bob', 'WITHDRAWAL', 'deb-bob', userB);
    expect(ledgerService.getBalance('USDT', userB)).toBe('9000');
    expect(ledgerService.getBalance('USDT', userA)).toBe('11000');
  });

  it('5. No multi-account mutation: un-scoped or scoped operations affect strictly one account', () => {
    // Explicit account credit
    ledgerService.credit('USDT', '1500', 'Single user', 'OTHER', 'single-1', userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('11500');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
    expect(ledgerService.getBalance('USDT', DEFAULT_ACCOUNT_ID)).toBe('10000');

    // Un-scoped credit targets only default account
    ledgerService.credit('USDT', '2000', 'Default only', 'OTHER', 'def-only');
    expect(ledgerService.getBalance('USDT', DEFAULT_ACCOUNT_ID)).toBe('12000');
    expect(ledgerService.getBalance('USDT', userA)).toBe('11500');
    expect(ledgerService.getBalance('USDT', userB)).toBe('10000');
  });

  it('6. Per-account idempotency: same referenceId on different accounts does not collide; duplicate on same account is ignored', () => {
    const sharedRef = 'shared-ref-123';

    // Same ref for User A
    ledgerService.credit('USDT', '500', 'Ref Test', 'OTHER', sharedRef, userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10500');

    // Duplicate ref for User A is ignored
    ledgerService.credit('USDT', '500', 'Ref Test Dup', 'OTHER', sharedRef, userA);
    expect(ledgerService.getBalance('USDT', userA)).toBe('10500');

    // Same ref for User B succeeds without collision
    ledgerService.credit('USDT', '500', 'Ref Test B', 'OTHER', sharedRef, userB);
    expect(ledgerService.getBalance('USDT', userB)).toBe('10500');
  });

  it('7. Spot BUY on BTCUSDT locks USDT in WalletService', async () => {
    // User A has 10,000 USDT
    // Simulate spot pending BUY order of 0.1 BTC at 50,000 USDT = 5000 USDT locked
    orderService['orders'].push({
      id: 'spot-buy-usdt-1',
      accountId: userA,
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const assetsA = await walletService.getAssets(userA);
    const usdtAsset = assetsA.find(a => a.asset === 'USDT');
    const usdcAsset = assetsA.find(a => a.asset === 'USDC');

    expect(usdtAsset).toBeDefined();
    expect(usdtAsset!.lockedBalance).toBe('5000');
    expect(usdtAsset!.totalBalance).toBe('15000'); // 10000 available + 5000 locked
    expect(usdcAsset).toBeUndefined();
  });

  it('8. Spot BUY on BTCUSDC locks USDC in WalletService and does not lock USDT', async () => {
    // User A has 10,000 USDT, 0 USDC
    // User A places a pending BUY order on BTCUSDC: 0.1 BTC at 50,000 USDC = 5000 USDC locked
    orderService['orders'].push({
      id: 'spot-buy-usdc-1',
      accountId: userA,
      symbol: 'BTCUSDC',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '0.1',
      status: 'PENDING',
      createdAt: Date.now(),
      updatedAt: Date.now()
    });

    const assetsA = await walletService.getAssets(userA);
    const usdtAsset = assetsA.find(a => a.asset === 'USDT');
    const usdcAsset = assetsA.find(a => a.asset === 'USDC');

    // USDT should have 0 locked
    expect(usdtAsset).toBeDefined();
    expect(usdtAsset!.lockedBalance).toBe('0');
    expect(usdtAsset!.totalBalance).toBe('10000');

    // USDC should have 5000 locked
    expect(usdcAsset).toBeDefined();
    expect(usdcAsset!.lockedBalance).toBe('5000');
    expect(usdcAsset!.availableBalance).toBe('0');
    expect(usdcAsset!.totalBalance).toBe('5000');
  });

  it('9. Existing users retain balances across multiple operations and reloads', () => {
    const customUser = 'user-custom-retained';
    ledgerService.credit('USDT', '25000', 'Init', 'DEPOSIT', 'init-cust', customUser);
    ledgerService.credit('ETH', '10', 'Init ETH', 'DEPOSIT', 'init-eth', customUser);

    expect(ledgerService.getBalance('USDT', customUser)).toBe('35000');
    expect(ledgerService.getBalance('ETH', customUser)).toBe('10');

    // Perform transfer to Futures
    ledgerService.credit('FUTURES_USDT', '5000', 'Transfer to Futures', 'TRANSFER', 'xfer-fut', customUser);
    ledgerService.debit('USDT', '5000', 'Transfer from Spot', 'TRANSFER', 'xfer-spot', customUser);

    expect(ledgerService.getBalance('USDT', customUser)).toBe('30000');
    expect(ledgerService.getBalance('FUTURES_USDT', customUser)).toBe('5000');
    expect(ledgerService.getBalance('ETH', customUser)).toBe('10');

    // Default account and other accounts unaffected
    expect(ledgerService.getBalance('USDT', DEFAULT_ACCOUNT_ID)).toBe('10000');
    expect(ledgerService.getBalance('FUTURES_USDT', DEFAULT_ACCOUNT_ID)).toBe('0');
  });

  it('10. Transaction history is isolated per account and maps all event types accurately', () => {
    ledgerService.credit('USDT', '1000', 'Deposit Alice', 'DEPOSIT', 'tx-a-1', userA);
    ledgerService.credit('USDT', '2000', 'Deposit Bob', 'DEPOSIT', 'tx-b-1', userB);

    const txA = transactionService.getTransactions(userA);
    const txB = transactionService.getTransactions(userB);

    expect(txA.some(t => t.description === 'Deposit Alice')).toBe(true);
    expect(txA.some(t => t.description === 'Deposit Bob')).toBe(false);

    expect(txB.some(t => t.description === 'Deposit Bob')).toBe(true);
    expect(txB.some(t => t.description === 'Deposit Alice')).toBe(false);
  });
});
