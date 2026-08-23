import { Decimal } from 'decimal.js';
import { safeParseArray, isValidFinancialString } from '../storageUtil';
import { apiClient } from '../api/client';
import { userService } from '../user/UserService';


export type TransactionStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export type TransactionType = 'DEPOSIT' | 'WITHDRAWAL';

export interface DemoTransaction {
  id: string;
  accountId?: string;
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
  private persistKey = 'demo_txs';
  private persist() {}
  private subscribers = new Set<any>();
  private transactions: any[] = [];
    constructor() {}

  private load() {
    try {
      if (typeof window === 'undefined' && typeof sessionStorage === 'undefined') return;
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        const parsed = safeParseArray<DemoTransaction>(data, t => (
          t && typeof t.id === 'string' && typeof t.asset === 'string' && isValidFinancialString(t.amount)
        ));
        if (parsed.length > 0 || data.trim() === '[]') {
          this.transactions = parsed.map(t => ({
            ...t,
            accountId: t.accountId || 'demo-user-1'
          }));
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

  public getTransactions(accountId?: string): DemoTransaction[] {
    const list = [...this.transactions].reverse();
    if (accountId) {
      return list.filter(t => t.accountId === accountId || (!t.accountId && accountId === 'demo-user-1'));
    }
    return list;
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

    public async createDeposit(asset: string, amount: string, accountId: string = 'demo-user-1'): Promise<any> {
    const val = this.validateAmount(amount);
    if (!val.valid) throw new Error(val.error);

    if (typeof window !== 'undefined') {
      const spotAccId = userService.getSpotAccountId();
      const res = await apiClient.post('/wallet/admin/paper-deposit', {
        targetAccountId: spotAccId,
        asset,
        amount,
        referenceId: Math.random().toString(36).substring(2, 11),
        description: 'Demo Deposit',
      });
      return res;
    }
    throw new Error('Paper deposit requires browser environment');
  }

  public async createWithdrawal(asset: string, amount: string, destinationLabel: string, availableBalance: string, accountId: string = 'demo-user-1'): Promise<any> {
    const val = this.validateAmount(amount);
    if (!val.valid) throw new Error(val.error);

    const amt = new Decimal(amount);
    if (amt.gt(new Decimal(availableBalance))) {
      throw new Error('Insufficient available balance');
    }

    if (typeof window !== 'undefined') {
      const spotAccId = userService.getSpotAccountId();
      const res = await apiClient.post('/wallet/withdraw', {
        accountId: spotAccId,
        asset,
        amount,
        referenceId: Math.random().toString(36).substring(2, 11),
        destinationAddress: destinationLabel,
        description: 'User withdrawal',
      });
      return res;
    }
    throw new Error('Withdrawal requires browser environment');
  }
}
export const demoTransactionService = new DemoTransactionService();
