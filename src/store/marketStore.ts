import { tradingPairRegistry } from '../services/market/TradingPairRegistry';
import { preferencesService } from '../services/user/PreferencesService';

type Listener = (symbol: string) => void;

class MarketStore {
  private selectedSymbol: string = 'BTCUSDT';
  private listeners: Set<Listener> = new Set();

  constructor() {
    const saved = localStorage.getItem('selectedSymbol');
    if (saved && tradingPairRegistry.isSupported(saved)) {
      this.selectedSymbol = saved;
    } else {
      const prefs = preferencesService.getPreferences();
      if (prefs && prefs.defaultMarket && tradingPairRegistry.isSupported(prefs.defaultMarket)) {
        this.selectedSymbol = prefs.defaultMarket;
      }
    }
  }

  getSelectedSymbol(): string {
    return this.selectedSymbol;
  }

  setSelectedSymbol(symbol: string): void {
    if (!tradingPairRegistry.isSupported(symbol)) {
      return;
    }
    this.selectedSymbol = symbol;
    localStorage.setItem('selectedSymbol', symbol);
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
