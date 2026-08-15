import { DemoTrade } from '../types/trades';

export class TradeService {
  private trades: DemoTrade[] = [];
  private persistKey = 'demo_trade_history';
  private subscribers: Set<() => void> = new Set();

  constructor(private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  private load() {
    try {
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        this.trades = JSON.parse(data);
      }
    } catch (e) {
      
    }
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.trades));
    } catch (e) {
      
    }
  }

  public recordTrade(trade: Omit<DemoTrade, 'id' | 'timestamp'>): DemoTrade {
    const newTrade: DemoTrade = {
      ...trade,
      id: Math.random().toString(36).substring(2, 11),
      timestamp: Date.now()
    };
    
    this.trades.unshift(newTrade);
    this.save();
    this.notify();
    return newTrade;
  }

  public getTradesByAccount(accountId: string): DemoTrade[] {
    return this.trades.filter(t => t.accountId === accountId);
  }

  public getTradesByOrder(orderId: string): DemoTrade[] {
    return this.trades.filter(t => t.orderId === orderId);
  }

  public reset() {
    this.trades = [];
    this.save();
    this.notify();
  }
}

export const tradeService = new TradeService(typeof window !== 'undefined');
