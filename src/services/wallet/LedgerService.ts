import { Decimal } from 'decimal.js';
import { WalletType } from './types';
import { safeParseArray, safeParseObject, isValidFinancialString, safeParseFinancialString } from '../storageUtil';

export type LedgerEntryType = 'DEPOSIT' | 'WITHDRAWAL' | 'TRANSFER' | 'REALIZED_PNL' | 'TRADING_FEE' | 'FUNDING' | 'MARGIN' | 'OTHER';
export type Direction = 'CREDIT' | 'DEBIT';
export type LedgerEntryStatus = 'COMPLETED' | 'PENDING' | 'FAILED' | 'CANCELLED';

export const DEFAULT_ACCOUNT_ID = 'demo-user-1';

export function normalizeAccountId(accountId?: string): string {
  if (
    !accountId ||
    accountId === DEFAULT_ACCOUNT_ID ||
    accountId === 'test' ||
    accountId.startsWith('test-') ||
    accountId.startsWith('test_') ||
    accountId.startsWith('acc-') ||
    accountId.startsWith('acc_')
  ) {
    return DEFAULT_ACCOUNT_ID;
  }
  return accountId;
}

export function createDefaultBalances(): Record<string, string> {
  return {
    USDT: '10000',
    FUTURES_USDT: '0',
    BTC: '0',
    ETH: '0',
    SOL: '0',
    XRP: '0',
    DOGE: '0',
    BNB: '0',
  };
}

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
  // Keyed by accountId -> asset -> string amount
  private balances: Record<string, Record<string, string>> = {
    [DEFAULT_ACCOUNT_ID]: createDefaultBalances()
  };
  private entries: LedgerEntry[] = [];
  private subscribers: Set<() => void> = new Set();
  private persist: boolean;
  private legacyMigrated: boolean = false;

  private readonly historyPersistKey = 'nova_ledger_history';
  private readonly balancesPersistKey = 'nova_ledger_balances';
  private readonly legacyStatePersistKey = 'demo_ledger_state';

  constructor(persist: boolean = false) {
    this.persist = persist;
    if (this.persist) {
      this.load();
    }
  }

  private load() {
    if (!this.persist) return;
    try {
      // 1. Load history
      const historyData = sessionStorage.getItem(this.historyPersistKey);
      if (historyData) {
        const parsed = safeParseArray<LedgerEntry>(historyData, (e) => (
          e && typeof e.id === 'string' && typeof e.asset === 'string' && isValidFinancialString(e.amount)
        ));
        if (parsed.length > 0 || historyData.trim() === '[]') {
          this.entries = parsed;
        }
      }

      // 2. Load balances
      const balancesData = sessionStorage.getItem(this.balancesPersistKey);
      if (balancesData) {
        const parsedBalances = safeParseObject<Record<string, any>>(balancesData, {});
        // Check if modern nested structure { [accountId]: { USDT: '...' } } or legacy flat { USDT: '...' }
        const firstKey = Object.keys(parsedBalances)[0];
        if (firstKey && typeof parsedBalances[firstKey] === 'object' && parsedBalances[firstKey] !== null) {
          // Modern nested structure
          for (const [accId, assetMap] of Object.entries(parsedBalances)) {
            if (typeof assetMap === 'object' && assetMap !== null) {
              const normId = normalizeAccountId(accId);
              if (!this.balances[normId]) {
                this.balances[normId] = createDefaultBalances();
              }
              for (const [k, v] of Object.entries(assetMap as Record<string, string>)) {
                if (typeof k === 'string' && isValidFinancialString(v)) {
                  this.balances[normId][k] = safeParseFinancialString(v, this.balances[normId][k] || '0');
                }
              }
            }
          }
        } else {
          // Legacy flat structure: migrate strictly to DEFAULT_ACCOUNT_ID
          this.legacyMigrated = true;
          for (const [k, v] of Object.entries(parsedBalances)) {
            if (typeof k === 'string' && isValidFinancialString(v)) {
              this.balances[DEFAULT_ACCOUNT_ID][k] = safeParseFinancialString(v, this.balances[DEFAULT_ACCOUNT_ID][k] || '0');
            }
          }
        }
      } else {
        const legacyData = sessionStorage.getItem(this.legacyStatePersistKey);
        if (legacyData) {
          const parsedLegacy = safeParseObject<{ balances?: Record<string, string> }>(legacyData, {});
          if (parsedLegacy.balances && typeof parsedLegacy.balances === 'object' && !Array.isArray(parsedLegacy.balances)) {
            this.legacyMigrated = true;
            for (const [k, v] of Object.entries(parsedLegacy.balances)) {
              if (typeof k === 'string' && isValidFinancialString(v)) {
                this.balances[DEFAULT_ACCOUNT_ID][k] = safeParseFinancialString(v, this.balances[DEFAULT_ACCOUNT_ID][k] || '0');
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
      // Sync legacy key with DEFAULT_ACCOUNT_ID's balances for backward compatibility
      sessionStorage.setItem(this.legacyStatePersistKey, JSON.stringify({
        balances: this.balances[DEFAULT_ACCOUNT_ID] || createDefaultBalances(),
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

  private getOrCreateBalances(accountId: string): Record<string, string> {
    const norm = normalizeAccountId(accountId);
    if (!this.balances[norm]) {
      this.balances[norm] = createDefaultBalances();
    }
    return this.balances[norm];
  }

  public getBalance(asset: string, accountId?: string): string {
    const targetAccountId = normalizeAccountId(accountId);
    const balances = this.getOrCreateBalances(targetAccountId);
    return balances[asset] || '0';
  }

  public getAllBalances(accountId?: string): Record<string, string> {
    const targetAccountId = normalizeAccountId(accountId);
    const balances = this.getOrCreateBalances(targetAccountId);
    return { ...balances };
  }

  public getHistory(accountId?: string): LedgerEntry[] {
    return this.getEntries(accountId);
  }

  public credit(
    asset: string,
    amount: string | number,
    reason: string,
    ledgerType: LedgerEntryType = 'OTHER',
    referenceId?: string,
    accountId?: string
  ): void {
    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      throw new Error('Credit amount must be positive');
    }

    const walletType: WalletType = asset === 'FUTURES_USDT' ? 'FUTURES' : 'SPOT';
    const normalizedType = (ledgerType === 'OTHER' ? 'credit' : ledgerType) as any;
    const targetAccountId = normalizeAccountId(accountId);

    // Account-aware idempotency check via referenceId + accountId + direction + wallet + type
    if (referenceId) {
      const isDuplicate = this.entries.some(e =>
        e.referenceId === referenceId &&
        normalizeAccountId(e.userId) === targetAccountId &&
        e.direction === 'CREDIT' &&
        e.wallet === walletType &&
        (e.type === normalizedType || e.type === ledgerType)
      );
      if (isDuplicate) {
        console.warn(`Duplicate ledger credit ignored: ${referenceId} for user ${targetAccountId}`);
        return;
      }
    }

    const balances = this.getOrCreateBalances(targetAccountId);
    const currentBalance = new Decimal(balances[asset] || '0');
    const newBalance = currentBalance.plus(amt);

    const entry: LedgerEntry = {
      id: Math.random().toString(36).substring(2, 11),
      userId: targetAccountId,
      type: normalizedType,
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

    balances[asset] = newBalance.toString();
    this.entries.unshift(entry);

    this.save();
    this.notify();
  }

  public debit(
    asset: string,
    amount: string | number,
    reason: string,
    ledgerType: LedgerEntryType = 'OTHER',
    referenceId?: string,
    accountId?: string
  ): void {
    const targetAccountId = normalizeAccountId(accountId);
    const amt = new Decimal(amount);
    if (amt.lte(0)) {
      throw new Error('Debit amount must be positive');
    }

    const walletType: WalletType = asset === 'FUTURES_USDT' ? 'FUTURES' : 'SPOT';
    const normalizedType = (ledgerType === 'OTHER' ? 'debit' : ledgerType) as any;

    // Account-aware idempotency check via referenceId + accountId + direction + wallet + type
    if (referenceId) {
      const isDuplicate = this.entries.some(e =>
        e.referenceId === referenceId &&
        normalizeAccountId(e.userId) === targetAccountId &&
        e.direction === 'DEBIT' &&
        e.wallet === walletType &&
        (e.type === normalizedType || e.type === ledgerType)
      );
      if (isDuplicate) {
        console.warn(`Duplicate ledger debit ignored: ${referenceId} for user ${targetAccountId}`);
        return;
      }
    }

    const balances = this.getOrCreateBalances(targetAccountId);
    const currentBalance = new Decimal(balances[asset] || '0');
    const newBalance = currentBalance.minus(amt);

    if (newBalance.lt(0)) {
      throw new Error(`Insufficient balance for ${asset}`);
    }

    const entry: LedgerEntry = {
      id: Math.random().toString(36).substring(2, 11),
      userId: targetAccountId,
      type: normalizedType,
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

    balances[asset] = newBalance.toString();
    this.entries.unshift(entry);
    this.save();
    this.notify();
  }

  public addEntry(entry: Omit<LedgerEntry, 'id' | 'createdAt'>): LedgerEntry {
    const accountId = normalizeAccountId(entry.userId);
    const newEntry: LedgerEntry = {
      ...entry,
      userId: accountId,
      reason: entry.reason || entry.description,
      id: Math.random().toString(36).substring(2, 11),
      createdAt: Date.now()
    };
    
    // Prevent duplicate entries based on referenceId, accountId, direction, wallet, and type
    if (newEntry.referenceId) {
      const isDuplicate = this.entries.some(e => 
        e.referenceId === newEntry.referenceId && 
        normalizeAccountId(e.userId) === accountId &&
        e.direction === newEntry.direction && 
        e.wallet === newEntry.wallet &&
        e.type === newEntry.type
      );
      if (isDuplicate) {
        console.warn(`Duplicate ledger entry ignored: ${newEntry.referenceId} for user ${accountId}`);
        return this.entries.find(e => 
          e.referenceId === newEntry.referenceId && 
          normalizeAccountId(e.userId) === accountId &&
          e.direction === newEntry.direction && 
          e.wallet === newEntry.wallet &&
          e.type === newEntry.type
        )!;
      }
    }

    const balances = this.getOrCreateBalances(accountId);

    // Sync balance if balanceAfter is provided
    const assetKey = newEntry.wallet === 'FUTURES' && newEntry.asset === 'USDT' ? 'FUTURES_USDT' : newEntry.asset;
    if (newEntry.balanceAfter !== undefined && newEntry.balanceAfter !== null) {
      balances[assetKey] = newEntry.balanceAfter;
    }

    this.entries.unshift(newEntry);
    this.save();
    this.notify();
    return newEntry;
  }

  public reset(accountId?: string) {
    if (accountId) {
      const norm = normalizeAccountId(accountId);
      this.balances[norm] = createDefaultBalances();
      this.entries = this.entries.filter(e => normalizeAccountId(e.userId) !== norm);
    } else {
      this.legacyMigrated = false;
      this.balances = {
        [DEFAULT_ACCOUNT_ID]: createDefaultBalances()
      };
      this.entries = [];
    }
    this.save();
    this.notify();
  }

  public getEntries(accountId?: string): LedgerEntry[] {
    if (accountId) {
      const norm = normalizeAccountId(accountId);
      return this.entries.filter(e => normalizeAccountId(e.userId) === norm);
    }
    return [...this.entries];
  }

  public getEntry(id: string): LedgerEntry | undefined {
    return this.entries.find(e => e.id === id);
  }

  public getEntriesByAsset(asset: string, accountId?: string): LedgerEntry[] {
    return this.getEntries(accountId).filter(e => e.asset === asset);
  }

  public getEntriesByWallet(wallet: WalletType, accountId?: string): LedgerEntry[] {
    return this.getEntries(accountId).filter(e => e.wallet === wallet);
  }

  public getEntriesByType(type: LedgerEntryType, accountId?: string): LedgerEntry[] {
    return this.getEntries(accountId).filter(e => e.type === type);
  }

  public getEntriesBySymbol(symbol: string, accountId?: string): LedgerEntry[] {
    return this.getEntries(accountId).filter(e => e.symbol === symbol);
  }

  public getEntriesByReference(referenceId: string, accountId?: string): LedgerEntry[] {
    return this.getEntries(accountId).filter(e => e.referenceId === referenceId);
  }
}

export const ledgerService = new LedgerService(typeof window !== 'undefined');
