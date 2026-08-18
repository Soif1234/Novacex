import { Decimal } from 'decimal.js';
import { WalletType } from './types';
import { safeParseArray, safeParseObject, isValidFinancialString, safeParseFinancialString } from '../storageUtil';

export type LedgerEntryType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'REALIZED_PNL' | 'TRADING_FEE' | 'FUNDING' | 'MARGIN' | 'OTHER';
export type Direction = 'CREDIT' | 'DEBIT';
export type LedgerEntryStatus = 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED';

export interface LedgerEntry {
  id: string;
  userId?: string;
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
  reason?: string;
  createdAt: number;
}

export class LedgerService {
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
  private entries: LedgerEntry[] = [];
  private historyPersistKey = 'demo_ledger_history';
  private balancesPersistKey = 'nova_ledger_balances';
  private legacyStatePersistKey = 'demo_ledger_state';
  private subscribers: Set<() => void> = new Set();

  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
  }

  private load() {
    try {
      if (typeof window === 'undefined' && typeof sessionStorage === 'undefined') return;

      // 1. Load history entries
      const historyData = sessionStorage.getItem(this.historyPersistKey);
      if (historyData) {
        const parsed = safeParseArray<LedgerEntry>(historyData, (e) => (
          e && typeof e.id === 'string' && typeof e.asset === 'string' && isValidFinancialString(e.amount)
        ));
        if (parsed.length > 0 || historyData.trim() === '[]') {
          this.entries = parsed;
        }
      }

      // 2. Load balances (first check modern key, then legacy key to preserve demo balances)
      const balancesData = sessionStorage.getItem(this.balancesPersistKey);
      if (balancesData) {
        const parsedBalances = safeParseObject<Record<string, string>>(balancesData, {});
        for (const [k, v] of Object.entries(parsedBalances)) {
          if (typeof k === 'string' && isValidFinancialString(v)) {
            this.balances[k] = safeParseFinancialString(v, this.balances[k] || '0');
          }
        }
      } else {
        const legacyData = sessionStorage.getItem(this.legacyStatePersistKey);
        if (legacyData) {
          const parsedLegacy = safeParseObject<{ balances?: Record<string, string> }>(legacyData, {});
          if (parsedLegacy.balances && typeof parsedLegacy.balances === 'object' && !Array.isArray(parsedLegacy.balances)) {
            for (const [k, v] of Object.entries(parsedLegacy.balances)) {
              if (typeof k === 'string' && isValidFinancialString(v)) {
                this.balances[k] = safeParseFinancialString(v, this.balances[k] || '0');
              }
            }
          }
        }
      }
    } catch (e) {}
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.historyPersistKey, JSON.stringify(this.entries));
      sessionStorage.setItem(this.balancesPersistKey, JSON.stringify(this.balances));
      // Sync legacy key so any external tool reading demo_ledger_state remains in sync
      sessionStorage.setItem(this.legacyStatePersistKey, JSON.stringify({
        balances: this.balances,
        history: this.entries
      }));
    } catch (e) {}
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
    return [...this.entries];
  }

  public credit(
    asset: string,
    amount: string | number,
    reason: string,
    ledgerType: LedgerEntryType = 'OTHER',
    referenceId?: string
  ): void {
    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      throw new Error('Credit amount must be positive');
    }

    const walletType: WalletType = asset === 'FUTURES_USDT' ? 'FUTURES' : 'SPOT';
    const displayAsset = asset === 'FUTURES_USDT' ? 'USDT' : asset;

    // Idempotency check via referenceId
    if (referenceId) {
      const isDuplicate = this.entries.some(e =>
        e.referenceId === referenceId &&
        e.direction === 'CREDIT' &&
        e.wallet === walletType &&
        e.type === ledgerType
      );
      if (isDuplicate) {
        console.warn(`Duplicate ledger credit ignored: ${referenceId}`);
        return;
      }
    }

    const currentBalance = new Decimal(this.getBalance(asset));
    const newBalance = currentBalance.plus(amt);

    const entry: LedgerEntry = {
      id: Math.random().toString(36).substring(2, 11),
      type: (ledgerType === 'OTHER' ? 'credit' : ledgerType) as any,
      asset: asset,
      amount: amt.toString(),
      balanceBefore: currentBalance.toString(),
      balanceAfter: newBalance.toString(),
      wallet: walletType,
      direction: 'CREDIT',
      status: 'COMPLETED',
      referenceId,
      description: reason,
      reason,
      createdAt: Date.now()
    };

    this.balances[asset] = newBalance.toString();
    this.entries.unshift(entry);
    this.save();
    this.notify();
  }

  public debit(
    asset: string,
    amount: string | number,
    reason: string,
    ledgerType: LedgerEntryType = 'OTHER',
    referenceId?: string
  ): void {
    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      throw new Error('Debit amount must be positive');
    }

    const walletType: WalletType = asset === 'FUTURES_USDT' ? 'FUTURES' : 'SPOT';

    // Idempotency check via referenceId
    if (referenceId) {
      const isDuplicate = this.entries.some(e =>
        e.referenceId === referenceId &&
        e.direction === 'DEBIT' &&
        e.wallet === walletType &&
        e.type === ledgerType
      );
      if (isDuplicate) {
        console.warn(`Duplicate ledger debit ignored: ${referenceId}`);
        return;
      }
    }

    const currentBalance = new Decimal(this.getBalance(asset));
    const newBalance = currentBalance.minus(amt);

    if (newBalance.lt(0)) {
      throw new Error(`Insufficient balance for ${asset}`);
    }

    const entry: LedgerEntry = {
      id: Math.random().toString(36).substring(2, 11),
      type: (ledgerType === 'OTHER' ? 'debit' : ledgerType) as any,
      asset: asset,
      amount: amt.toString(),
      balanceBefore: currentBalance.toString(),
      balanceAfter: newBalance.toString(),
      wallet: walletType,
      direction: 'DEBIT',
      status: 'COMPLETED',
      referenceId,
      description: reason,
      reason,
      createdAt: Date.now()
    };

    this.balances[asset] = newBalance.toString();
    this.entries.unshift(entry);
    this.save();
    this.notify();
  }

  public addEntry(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): LedgerEntry {
    const newEntry: LedgerEntry = {
      ...entry,
      reason: entry.reason || entry.description,
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
        return this.entries.find(e => 
          e.referenceId === newEntry.referenceId && 
          e.direction === newEntry.direction && 
          e.wallet === newEntry.wallet &&
          e.type === newEntry.type
        )!;
      }
    }

    // Sync balance if balanceAfter is provided
    const assetKey = newEntry.wallet === 'FUTURES' && newEntry.asset === 'USDT' ? 'FUTURES_USDT' : newEntry.asset;
    if (newEntry.balanceAfter !== undefined && newEntry.balanceAfter !== null) {
      this.balances[assetKey] = newEntry.balanceAfter;
    }

    this.entries.unshift(newEntry);
    this.save();
    this.notify();
    return newEntry;
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
      BNB: '0',
    };
    this.entries = [];
    this.save();
    this.notify();
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
