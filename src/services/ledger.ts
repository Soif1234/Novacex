import { Decimal } from 'decimal.js';
import { ledgerService, LedgerEntryType } from './wallet/LedgerService';
import { transactionService } from './transactions/TransactionService';
import { WalletType } from './wallet/types';
import { TransactionType } from './transactions/types';

export interface LedgerEntry {
  id: string;
  timestamp: number;
  asset: string;
  type: 'credit' | 'debit';
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  reason: string;
}

export class DemoLedger {
  private balances: Record<string, string> = {
    USDT: '10000',
    FUTURES_USDT: '0',
    BTC: '0',
    ETH: '0',
    SOL: '0',
    XRP: '0',
    DOGE: '0',
    BNB: '0',
  };
  private history: LedgerEntry[] = [];
  private persistKey = 'demo_ledger_state';
  private subscribers: Set<() => void> = new Set();

  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
  }

  private load() {
    try {
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (parsed.balances && parsed.history) {
          this.balances = parsed.balances;
          this.history = parsed.history;
        }
      }
    } catch (e) {
      
    }
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify({
        balances: this.balances,
        history: this.history
      }));
    } catch (e) {
      
    }
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public getBalance(asset: string): string {
    return this.balances[asset] || '0';
  }

  public getAllBalances(): Record<string, string> {
    return { ...this.balances };
  }

  public getHistory(): LedgerEntry[] {
    return [...this.history];
  }

  private record(
    asset: string,
    type: 'credit' | 'debit',
    amount: Decimal,
    balanceBefore: Decimal,
    balanceAfter: Decimal,
    reason: string,
    ledgerType: string = 'OTHER',
    referenceId?: string
  ) {
    const entry: LedgerEntry = {
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now(),
      asset,
      type,
      amount: amount.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      reason
    };
    this.history.unshift(entry); // Add to beginning
    this.balances[asset] = balanceAfter.toString();
    this.save();
    this.notify();

    // Wire up to LedgerService for F19D
    const walletType: WalletType = asset === 'FUTURES_USDT' ? 'FUTURES' : 'SPOT';
    const displayAsset = asset === 'FUTURES_USDT' ? 'USDT' : asset;
    
    // De-duplicate in ledgerService itself
    ledgerService.addEntry({
      type: ledgerType as LedgerEntryType,
      asset: displayAsset,
      amount: amount.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      wallet: walletType,
      direction: type === 'credit' ? 'CREDIT' : 'DEBIT',
      status: 'COMPLETED',
      referenceId: referenceId,
      description: reason
    });
  }

  public credit(asset: string, amount: string | number, reason: string, ledgerType: string = 'OTHER', referenceId?: string): void {
    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      throw new Error('Credit amount must be positive');
    }

    const currentBalance = new Decimal(this.getBalance(asset));
    const newBalance = currentBalance.plus(amt);

    this.record(asset, 'credit', amt, currentBalance, newBalance, reason, ledgerType, referenceId);
  }

  public debit(asset: string, amount: string | number, reason: string, ledgerType: string = 'OTHER', referenceId?: string): void {
    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      throw new Error('Debit amount must be positive');
    }

    const currentBalance = new Decimal(this.getBalance(asset));
    const newBalance = currentBalance.minus(amt);

    if (newBalance.lt(0)) {
      throw new Error(`Insufficient balance for ${asset}`);
    }

    this.record(asset, 'debit', amt, currentBalance, newBalance, reason, ledgerType, referenceId);
  }

  public reset() {
    this.balances = {
      USDT: '10000',
    FUTURES_USDT: '0',
      BTC: '0',
      ETH: '0',
      SOL: '0',
      XRP: '0',
      DOGE: '0',
    };
    this.history = [];
    this.save();
    this.notify();
  }
}

// Export a singleton instance for the app to use
export const demoLedger = new DemoLedger(typeof window !== 'undefined');
