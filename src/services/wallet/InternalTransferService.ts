import { demoLedger } from '../ledger';
import { Decimal } from 'decimal.js';
import { walletService } from './WalletService';
import { WalletType } from './types';

export type TransferStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface InternalTransfer {
  id: string;
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
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        const parsed = JSON.parse(data);
        if (Array.isArray(parsed)) {
          this.transfers = parsed.filter(t => t && typeof t === 'object' && typeof t.id === 'string');
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

  public getTransfers(): InternalTransfer[] {
    return [...this.transfers].reverse();
  }

  public getTransfer(id: string): InternalTransfer | undefined {
    return this.transfers.find(t => t.id === id);
  }

  public async validateTransfer(
    asset: string,
    amount: string,
    fromWallet: WalletType,
    toWallet: WalletType
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

    const balances = await walletService.getWalletBalances();
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
    toWallet: WalletType
  ): Promise<InternalTransfer> {
    const validation = await this.validateTransfer(asset, amount, fromWallet, toWallet);

    if (!validation.valid) {
      throw new Error(validation.error);
    }

    const transfer: InternalTransfer = {
      id: Math.random().toString(36).substring(2, 11),
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

    // In this demo, we can just execute immediately
    await this.executeTransfer(transfer.id);

    return transfer;
  }

  public async executeTransfer(id: string): Promise<void> {
    const transfer = this.getTransfer(id);
    if (!transfer || transfer.status !== 'PENDING') {
      throw new Error('Transfer not found or not in PENDING state');
    }

    const validation = await this.validateTransfer(transfer.asset, transfer.amount, transfer.fromWallet, transfer.toWallet);
    
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
      
      demoLedger.debit(fromAsset, transfer.amount, reason, 'TRANSFER', transfer.id);
      demoLedger.credit(toAsset, transfer.amount, reason, 'TRANSFER', transfer.id);
      
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
