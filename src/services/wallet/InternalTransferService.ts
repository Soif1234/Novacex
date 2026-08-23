import { demoLedger } from '../ledger';
import { Decimal } from 'decimal.js';
import { walletService } from './WalletService';
import { WalletType } from './types';
import { safeParseArray, isValidFinancialString } from '../storageUtil';
import { apiClient } from '../api/client';
import { userService } from '../user/UserService';


export type TransferStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface InternalTransfer {
  id: string;
  accountId?: string;
  asset: string;
  amount: string;
  fromWallet: WalletType;
  toWallet: WalletType;
  status: TransferStatus;
  createdAt: number;
  completedAt?: number;
}

export class InternalTransferService {
  private transfers: InternalTransfer[] = [];
  private persistKey = 'demo_transfers_state';
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
        const parsed = safeParseArray<InternalTransfer>(data, t => (
          t && typeof t.id === 'string' && typeof t.asset === 'string' && isValidFinancialString(t.amount)
        ));
        if (parsed.length > 0 || data.trim() === '[]') {
          this.transfers = parsed.map(t => ({
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
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.transfers));
    } catch (e) {}
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public getTransfers(accountId?: string): InternalTransfer[] {
    const list = [...this.transfers].reverse();
    if (accountId) {
      return list.filter(t => t.accountId === accountId || (!t.accountId && accountId === 'demo-user-1'));
    }
    return list;
  }

  public getTransfer(id: string): InternalTransfer | undefined {
    return this.transfers.find(t => t.id === id);
  }

  public async validateTransfer(
    asset: string,
    amount: string,
    fromWallet: WalletType,
    toWallet: WalletType,
    accountId: string = 'demo-user-1'
  ): Promise<{ valid: boolean; error?: string }> {
    if (fromWallet === toWallet) {
      return { valid: false, error: 'Cannot transfer to the same wallet' };
    }

    if (asset !== 'USDT') {
      return { valid: false, error: 'This asset cannot be transferred between these wallets.' };
    }

    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      return { valid: false, error: 'Transfer amount must be greater than zero' };
    }

    const balances = await walletService.getWalletBalances(accountId);
    const available = new Decimal(fromWallet === 'SPOT' ? balances.spotAvailable : balances.futuresAvailable);

    if (available.lt(amt)) {
      return { valid: false, error: 'Insufficient balance for transfer' };
    }

    return { valid: true };
  }

  public async createTransfer(
    asset: string,
    amount: string,
    fromWallet: WalletType,
    toWallet: WalletType,
    accountId: string = 'demo-user-1'
  ): Promise<InternalTransfer> {
    const validation = await this.validateTransfer(asset, amount, fromWallet, toWallet, accountId);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const transfer: InternalTransfer = {
      id: Math.random().toString(36).substring(2, 11),
      accountId,
      asset,
      amount,
      fromWallet,
      toWallet,
      status: 'PENDING',
      createdAt: Date.now()
    };

    this.transfers.push(transfer);
    this.save();
    this.notify();

    // Execute immediately for demo
    await this.executeTransfer(transfer.id);

    return transfer;
  }

  public async executeTransfer(id: string): Promise<void> {
    const transfer = this.getTransfer(id);
    if (!transfer || transfer.status !== 'PENDING') {
      throw new Error('Transfer not found or not in PENDING state');
    }

    const accountId = transfer.accountId || 'demo-user-1';
    const validation = await this.validateTransfer(transfer.asset, transfer.amount, transfer.fromWallet, transfer.toWallet, accountId);
    
    if (!validation.valid) {
      transfer.status = 'FAILED';
      transfer.completedAt = Date.now();
      this.save();
      this.notify();
      throw new Error(validation.error);
    }

    try {
      const fromAsset = transfer.fromWallet === 'FUTURES' ? 'FUTURES_USDT' : 'USDT';
      const toAsset = transfer.toWallet === 'FUTURES' ? 'FUTURES_USDT' : 'USDT';
      
      const reason = `Internal Transfer from ${transfer.fromWallet} to ${transfer.toWallet}`;
      
      if (typeof window !== 'undefined') {
        const spotAccId = userService.getSpotAccountId();
        const futuresAccId = userService.getFuturesAccountId();
        const fromAccId = transfer.fromWallet === 'SPOT' ? spotAccId : futuresAccId;
        const toAccId = transfer.toWallet === 'SPOT' ? spotAccId : futuresAccId;

        apiClient.post('/wallet/transfer', {
          fromAccountId: fromAccId,
          toAccountId: toAccId,
          asset: transfer.asset,
          amount: transfer.amount,
          referenceId: transfer.id,
          description: reason,
        }).catch(() => {});
      }

      demoLedger.debit(fromAsset, transfer.amount, reason, 'TRANSFER', transfer.id, accountId);
      demoLedger.credit(toAsset, transfer.amount, reason, 'TRANSFER', transfer.id, accountId);
      
      transfer.status = 'COMPLETED';
      transfer.completedAt = Date.now();
      
      this.save();
      this.notify();
    } catch (e: any) {
      transfer.status = 'FAILED';
      transfer.completedAt = Date.now();
      this.save();
      this.notify();
      throw new Error(`Transfer failed: ${e.message}`);
    }
  }

}

export const internalTransferService = new InternalTransferService(typeof window !== 'undefined');
