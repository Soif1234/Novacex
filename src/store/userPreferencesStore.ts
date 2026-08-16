import { tradingPairRegistry } from '../services/market/TradingPairRegistry';

type Listener = () => void;

class UserPreferencesStore {
  private favorites: string[] = [];
  private recentPairs: string[] = [];
  private listeners: Set<Listener> = new Set();

  constructor() {
    this.loadFromStorage();
  }

  private loadFromStorage() {
    try {
      const savedFavs = localStorage.getItem('nova_favorites');
      if (savedFavs) {
        const parsedFavs = JSON.parse(savedFavs) as string[];
        this.favorites = parsedFavs.filter(sym => tradingPairRegistry.isSupported(sym));
      }

      const savedRecents = localStorage.getItem('nova_recents');
      if (savedRecents) {
        const parsedRecents = JSON.parse(savedRecents) as string[];
        this.recentPairs = parsedRecents.filter(sym => tradingPairRegistry.isSupported(sym));
      }
    } catch (e) {
      console.error('Failed to load user preferences', e);
    }
  }

  private saveToStorage() {
    localStorage.setItem('nova_favorites', JSON.stringify(this.favorites));
    localStorage.setItem('nova_recents', JSON.stringify(this.recentPairs));
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
