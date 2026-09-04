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

/**
 * Generates a cryptographically secure, collision-resistant reference identifier
 * for internal financial transfers.
 *
 * Uses the platform cryptographic API (crypto.randomUUID) with an RFC 4122 v4
 * CSPRNG fallback (crypto.getRandomValues). Avoids Math.random() and timestamp-only keys.
 */
export function generateReferenceId(): string {
  if (typeof crypto !== 'undefined') {
    if (typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    if (typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // UUID v4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variant RFC 4122
      const hex = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  throw new Error('Cryptographically secure random number generator is unavailable');
}

export class InternalTransferService {
  private persistKey = 'demo_transfers';
  private persist() {}
  private subscribers = new Set<any>();
  private transfers: any[] = [];
  constructor() {}

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

  public async createTransfer(
    asset: string,
    amount: string,
    fromWallet: WalletType,
    toWallet: WalletType,
    accountId: string = 'demo-user-1',
    customReferenceId?: string
  ): Promise<any> {
    if (fromWallet === toWallet) {
      throw new Error('Cannot transfer to the same wallet');
    }
    const amt = new Decimal(amount);
    if (amt.lte(0)) throw new Error('Transfer amount must be greater than zero');

    if (typeof window !== 'undefined') {
      const spotAccId = userService.getSpotAccountId();
      const futuresAccId = userService.getFuturesAccountId();
      const fromAccId = fromWallet === 'SPOT' ? spotAccId : futuresAccId;
      const toAccId = toWallet === 'SPOT' ? spotAccId : futuresAccId;

      const referenceId = customReferenceId && customReferenceId.trim()
        ? customReferenceId.trim()
        : generateReferenceId();

      const res = await apiClient.post('/wallet/transfer', {
        fromAccountId: fromAccId,
        toAccountId: toAccId,
        asset,
        amount,
        referenceId,
        description: `Internal Transfer from ${fromWallet} to ${toWallet}`,
      });
      return res;
    }
    throw new Error('Transfer requires browser environment');
  }
}
export const internalTransferService = new InternalTransferService();
