import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { preferencesService } from '../services/user/PreferencesService';

type Listener = (symbol: string) => void;

class MarketStore {
  private selectedSymbol: string = 'BTCUSDT';
  private listeners: Set<Listener> = new Set();

  constructor() {
    const saved = localStorage.getItem('selectedSymbol');
    if (saved && tradingPairRegistry.isSupported(saved)) {
      this.selectedSymbol = tradingPairRegistry.resolveCanonicalSymbol(saved);
    } else {
      const prefs = preferencesService.getPreferences();
      if (prefs && prefs.defaultMarket && tradingPairRegistry.isSupported(prefs.defaultMarket)) {
        this.selectedSymbol = tradingPairRegistry.resolveCanonicalSymbol(prefs.defaultMarket);
      }
    }
  }

  getSelectedSymbol(): string {
    return this.selectedSymbol;
  }

  setSelectedSymbol(symbol: string): void {
    if (!symbol) return;
    const canonical = tradingPairRegistry.resolveCanonicalSymbol(symbol);
    if (!tradingPairRegistry.isSupported(canonical) && !tradingPairRegistry.isSupported(symbol)) {
      return;
    }
    this.selectedSymbol = canonical;
    localStorage.setItem('selectedSymbol', canonical);
    this.notify();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify() {
    this.listeners.forEach(l => l(this.selectedSymbol));
  }
}

export const marketStore = new MarketStore();
