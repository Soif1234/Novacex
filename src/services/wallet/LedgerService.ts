import { Decimal } from 'decimal.js';
import { WalletType } from './types';

export type LedgerEntryType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'REALIZED_PNL' | 'TRADING_FEE' | 'FUNDING' | 'MARGIN' | 'OTHER';
export type Direction = 'CREDIT' | 'DEBIT';
export type LedgerEntryStatus = 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED';

export interface LedgerEntry {
  id: string;
  type: LedgerEntryType;
  asset: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  wallet: WalletType;
  direction: Direction;
  status: LedgerEntryStatus;
  referenceId?: string;
  symbol?: string;
  description: string;
  createdAt: number;
}

export class LedgerService {
  private entries: LedgerEntry[] = [];
  private persistKey = 'demo_ledger_history';
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
        this.entries = JSON.parse(data);
      }
    } catch (e) {}
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.entries));
    } catch (e) {}
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public addEntry(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): LedgerEntry {
    const newEntry: LedgerEntry = {
      ...entry,
      id: Math.random().toString(36).substring(2, 11),
      createdAt: Date.now()
    };
    
    // Prevent duplicate entries based on referenceId, direction, wallet, and type
    if (newEntry.referenceId) {
      const isDuplicate = this.entries.some(e => 
        e.referenceId === newEntry.referenceId && 
        e.direction === newEntry.direction && 
        e.wallet === newEntry.wallet &&
        e.type === newEntry.type
      );
      if (isDuplicate) {
        console.warn(`Duplicate ledger entry ignored: ${newEntry.referenceId}`);
        // Return existing entry to avoid breaking callers
        return this.entries.find(e => 
          e.referenceId === newEntry.referenceId && 
          e.direction === newEntry.direction && 
          e.wallet === newEntry.wallet &&
          e.type === newEntry.type
        )!;
      }
    }

    this.entries.unshift(newEntry);
    this.save();
    this.notify();
    return newEntry;
  }

  public getEntries(): LedgerEntry[] {
    return [...this.entries];
  }

  public getEntry(id: string): LedgerEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  public getEntriesByAsset(asset: string): LedgerEntry[] {
    return this.entries.filter(e => e.asset === asset);
  }

  public getEntriesByWallet(wallet: WalletType): LedgerEntry[] {
    return this.entries.filter(e => e.wallet === wallet);
  }

  public getEntriesByType(type: LedgerEntryType): LedgerEntry[] {
    return this.entries.filter(e => e.type === type);
  }

  public getEntriesBySymbol(symbol: string): LedgerEntry[] {
    return this.entries.filter(e => e.symbol === symbol);
  }

  public getEntriesByReference(referenceId: string): LedgerEntry[] {
    return this.entries.filter(e => e.referenceId === referenceId);
  }

  
}

export const ledgerService = new LedgerService(typeof window !== 'undefined');
