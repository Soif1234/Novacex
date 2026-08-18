import { demoLedger } from '../ledger';
import { Decimal } from 'decimal.js';
import { safeParseArray, isValidFinancialString } from '../storageUtil';

export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TransactionType = 'DEPOSIT' | 'WITHDRAWAL';

export interface DemoTransaction {
  id: string;
  type: TransactionType;
  asset: string;
  amount: string;
  destinationLabel?: string;
  status: TransactionStatus;
  createdAt: number;
  completedAt?: number;
  method: 'DEMO';
}

export class DemoTransactionService {
  private transactions: DemoTransaction[] = [];
  private persistKey = 'demo_transactions_state';
  private subscribers: Set<() => void> = new Set();

  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
  }

  private load() {
    try {
      if (typeof window === 'undefined' && typeof sessionStorage === 'undefined') return;
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        const parsed = safeParseArray<DemoTransaction>(data, t => (
          t && typeof t.id === 'string' && typeof t.asset === 'string' && isValidFinancialString(t.amount)
        ));
        if (parsed.length > 0 || data.trim() === '[]') {
          this.transactions = parsed;
        }
      }
    } catch (e) {}
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.transactions));
    } catch (e) {}
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public getTransactions(): DemoTransaction[] {
    return [...this.transactions].reverse();
  }

  public validateAmount(amount: string): { valid: boolean; error?: string } {
    try {
      const amt = new Decimal(amount);
      if (amt.isNaN() || !amt.isFinite()) {
        return { valid: false, error: 'Invalid amount' };
      }
      if (amt.lte(0)) {
        return { valid: false, error: 'Amount must be greater than zero' };
      }
      return { valid: true };
    } catch {
      return { valid: false, error: 'Invalid numeric format' };
    }
  }

  public async createDeposit(asset: string, amount: string): Promise<DemoTransaction> {
    const val = this.validateAmount(amount);
    if (!val.valid) throw new Error(val.error);

    const tx: DemoTransaction = {
      id: Math.random().toString(36).substring(2, 11),
      type: 'DEPOSIT',
      asset,
      amount,
      status: 'PENDING',
      createdAt: Date.now(),
      method: 'DEMO'
    };
    
    this.transactions.push(tx);
    this.save();
    this.notify();

    // Execute immediately for demo
    return this.executeDeposit(tx.id);
  }

  private executeDeposit(id: string): DemoTransaction {
    const tx = this.transactions.find(t => t.id === id);
    if (!tx || tx.type !== 'DEPOSIT') throw new Error('Deposit not found');
    
    try {
      demoLedger.credit(tx.asset, tx.amount, 'Demo Deposit', 'DEPOSIT', tx.id);
      tx.status = 'COMPLETED';
      tx.completedAt = Date.now();
    } catch (e: any) {
      tx.status = 'FAILED';
      tx.completedAt = Date.now();
    }
    
    this.save();
    this.notify();
    return tx;
  }

  public async createWithdrawal(asset: string, amount: string, destinationLabel: string, availableBalance: string): Promise<DemoTransaction> {
    const val = this.validateAmount(amount);
    if (!val.valid) throw new Error(val.error);

    if (new Decimal(amount).gt(new Decimal(availableBalance))) {
      throw new Error('Insufficient available balance');
    }

    const tx: DemoTransaction = {
      id: Math.random().toString(36).substring(2, 11),
      type: 'WITHDRAWAL',
      asset,
      amount,
      destinationLabel,
      status: 'PENDING',
      createdAt: Date.now(),
      method: 'DEMO'
    };

    this.transactions.push(tx);
    this.save();
    this.notify();

    // Execute immediately for demo
    return this.executeWithdrawal(tx.id);
  }

  private executeWithdrawal(id: string): DemoTransaction {
    const tx = this.transactions.find(t => t.id === id);
    if (!tx || tx.type !== 'WITHDRAWAL') throw new Error('Withdrawal not found');

    try {
      demoLedger.debit(tx.asset, tx.amount, 'Demo Withdrawal', 'WITHDRAWAL', tx.id);
      tx.status = 'COMPLETED';
      tx.completedAt = Date.now();
    } catch (e: any) {
      tx.status = 'FAILED';
      tx.completedAt = Date.now();
    }

    this.save();
    this.notify();
    return tx;
  }
}

export const demoTransactionService = new DemoTransactionService(typeof window !== 'undefined');
