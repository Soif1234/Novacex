import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { safeParseJSON } from '../services/storageUtil';
import { userService } from '../services/user/UserService';

type Listener = () => void;

class UserPreferencesStore {
  private favorites: string[] = [];
  private recentPairs: string[] = [];
  private listeners: Set<Listener> = new Set();
  private currentAccountId: string = 'demo-user-1';

  constructor() {
    if (typeof window !== 'undefined') {
      const u = userService.getCurrentUser();
      if (u && u.id) {
        this.currentAccountId = u.id;
      }
      userService.subscribe((user) => {
        const newAcc = user?.id || 'demo-user-1';
        this.setAccount(newAcc);
      });
    }
    this.loadFromStorage();
  }

  private getFavKey(accountId: string = this.currentAccountId): string {
    return accountId === 'demo-user-1' ? 'nova_favorites' : `nova_favorites_${accountId}`;
  }

  private getRecKey(accountId: string = this.currentAccountId): string {
    return accountId === 'demo-user-1' ? 'nova_recents' : `nova_recents_${accountId}`;
  }

  public setAccount(accountId: string) {
    if (this.currentAccountId !== accountId) {
      this.currentAccountId = accountId;
      this.loadFromStorage();
      this.notify();
    }
  }

  public getAccountId(): string {
    return this.currentAccountId;
  }

  private loadFromStorage() {
    try {
      if (typeof localStorage === 'undefined') return;
      this.favorites = [];
      this.recentPairs = [];

      const favKey = this.getFavKey();
      const savedFavs = localStorage.getItem(favKey);
      if (savedFavs) {
        const parsedFavs = safeParseJSON<string[]>(savedFavs, [], Array.isArray);
        this.favorites = parsedFavs.filter(sym => typeof sym === 'string' && tradingPairRegistry.isSupported(sym));
      }

      const recKey = this.getRecKey();
      const savedRecents = localStorage.getItem(recKey);
      if (savedRecents) {
        const parsedRecents = safeParseJSON<string[]>(savedRecents, [], Array.isArray);
        this.recentPairs = parsedRecents.filter(sym => typeof sym === 'string' && tradingPairRegistry.isSupported(sym));
      }
    } catch (e) {
      console.error('Failed to load user preferences', e);
    }
  }

  private saveToStorage() {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(this.getFavKey(), JSON.stringify(this.favorites));
    localStorage.setItem(this.getRecKey(), JSON.stringify(this.recentPairs));
    this.notify();
  }

  public reload() {
    this.loadFromStorage();
  }

  public reset(accountId?: string) {
    if (typeof localStorage === 'undefined') return;
    if (accountId) {
      localStorage.removeItem(this.getFavKey(accountId));
      localStorage.removeItem(this.getRecKey(accountId));
      if (accountId === this.currentAccountId) {
        this.favorites = [];
        this.recentPairs = [];
      }
    } else {
      localStorage.removeItem('nova_favorites');
      localStorage.removeItem('nova_recents');
      this.favorites = [];
      this.recentPairs = [];
    }
    this.notify();
  }

  public getFavorites(): string[] {
    return this.favorites;
  }

  public toggleFavorite(symbol: string) {
    if (!tradingPairRegistry.isSupported(symbol)) return;

    if (this.favorites.includes(symbol)) {
      this.favorites = this.favorites.filter(s => s !== symbol);
    } else {
      // Most recently favorited first
      this.favorites = [symbol, ...this.favorites];
    }
    this.saveToStorage();
  }

  public isFavorite(symbol: string): boolean {
    return this.favorites.includes(symbol);
  }

  public getRecentPairs(): string[] {
    return this.recentPairs;
  }

  public addRecentPair(symbol: string) {
    if (!tradingPairRegistry.isSupported(symbol)) return;

    // Remove if exists to bring to top
    const filtered = this.recentPairs.filter(s => s !== symbol);
    filtered.unshift(symbol);
    
    // Keep max 5
    this.recentPairs = filtered.slice(0, 5);
    this.saveToStorage();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l());
  }
}

export const userPreferencesStore = new UserPreferencesStore();
