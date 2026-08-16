import { PriceAlert, AlertTriggeredEvent } from '../../types/alerts';
import { tickerService } from '../market/TickerService';
import { tradingPairRegistry } from '../market/TradingPairRegistry';
import { Decimal } from 'decimal.js';

type AlertListener = (event: AlertTriggeredEvent) => void;

class PriceAlertService {
  private alerts: PriceAlert[] = [];
  private listeners: Set<AlertListener> = new Set();
  private tickerUnsubscribe: (() => void) | null = null;
  private isInitialized = false;

  constructor() {
    this.load();
  }

  public initialize() {
    if (this.isInitialized) return;
    this.tickerUnsubscribe = tickerService.subscribe(this.onTickerUpdate);
    this.isInitialized = true;
  }

  public destroy() {
    if (this.tickerUnsubscribe) {
      this.tickerUnsubscribe();
      this.tickerUnsubscribe = null;
    }
    this.isInitialized = false;
  }

  private load() {
    try {
      if (typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('nova_price_alerts');
        if (stored) {
          this.alerts = JSON.parse(stored);
        }
      }
    } catch (e) {
      console.error('Failed to load price alerts', e);
    }
  }

  private save() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('nova_price_alerts', JSON.stringify(this.alerts));
      }
    } catch (e) {
      console.error('Failed to save price alerts', e);
    }
  }

  public createAlert(
    symbol: string,
    marketType: 'SPOT' | 'FUTURES',
    condition: 'ABOVE' | 'BELOW',
    targetPrice: string,
    repeat: 'ONCE' | 'REPEATING'
  ): PriceAlert {
    // Validate Symbol & MarketType
    const pair = tradingPairRegistry.getPair(symbol);
    if (!pair) {
      throw new Error(`Invalid symbol: ${symbol}`);
    }
    if (pair.marketType !== marketType) {
      throw new Error(`Symbol ${symbol} does not support market type ${marketType}`);
    }

    // Validate Condition
    if (condition !== 'ABOVE' && condition !== 'BELOW') {
      throw new Error(`Invalid condition: ${condition}`);
    }

    // Validate Target Price
    let priceDecimal: Decimal;
    try {
      priceDecimal = new Decimal(targetPrice);
    } catch (e) {
      throw new Error('Target price must be numeric');
    }

    if (!priceDecimal.isFinite() || priceDecimal.isNaN()) {
      throw new Error('Target price must be numeric');
    }
    if (priceDecimal.lte(0)) {
      throw new Error('Target price must be greater than zero');
    }

    const alert: PriceAlert = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      symbol,
      marketType,
      condition,
      targetPrice: priceDecimal.toString(), // Normalize
      status: 'ACTIVE',
      createdAt: Date.now(),
      repeat,
    };

    // Initialize lastCheckedPrice if ticker data is already available
    const ticker = tickerService.getTicker(symbol);
    if (ticker && ticker.lastPrice) {
      alert.lastCheckedPrice = ticker.lastPrice;
    }

    this.alerts.push(alert);
    this.save();
    return alert;
  }

  public getAlert(id: string): PriceAlert | undefined {
    return this.alerts.find((a) => a.id === id);
  }

  public getAlerts(): PriceAlert[] {
    return [...this.alerts];
  }

  public updateAlert(id: string, updates: Partial<Pick<PriceAlert, 'targetPrice' | 'condition' | 'repeat' | 'status'>>): PriceAlert {
    const alert = this.alerts.find((a) => a.id === id);
    if (!alert) {
      throw new Error(`Alert not found: ${id}`);
    }

    if (updates.targetPrice !== undefined) {
      const priceDecimal = new Decimal(updates.targetPrice);
      if (!priceDecimal.isFinite() || priceDecimal.isNaN() || priceDecimal.lte(0)) {
        throw new Error('Invalid target price');
      }
      alert.targetPrice = priceDecimal.toString();
      // Reset lastCheckedPrice to require crossing logic again if price changed
      const ticker = tickerService.getTicker(alert.symbol);
      alert.lastCheckedPrice = ticker ? ticker.lastPrice : undefined;
    }

    if (updates.condition !== undefined) {
      if (updates.condition !== 'ABOVE' && updates.condition !== 'BELOW') {
        throw new Error('Invalid condition');
      }
      alert.condition = updates.condition;
    }

    if (updates.repeat !== undefined) {
      alert.repeat = updates.repeat;
    }

    if (updates.status !== undefined) {
      alert.status = updates.status;
    }

    this.save();
    return alert;
  }

  public cancelAlert(id: string): void {
    const alert = this.alerts.find((a) => a.id === id);
    if (alert) {
      alert.status = 'CANCELLED';
      this.save();
    }
  }

  public deleteAlert(id: string): void {
    this.alerts = this.alerts.filter((a) => a.id !== id);
    this.save();
  }

  public subscribe(listener: AlertListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyTrigger(event: AlertTriggeredEvent) {
    this.listeners.forEach((listener) => listener(event));
  }

  // Exposed for testing/manual evaluation
  public evaluateAlert(alert: PriceAlert, currentPriceStr: string): boolean {
    if (alert.status !== 'ACTIVE') return false;

    const currentPrice = new Decimal(currentPriceStr);
    const targetPrice = new Decimal(alert.targetPrice);
    const lastCheckedPriceStr = alert.lastCheckedPrice;

    if (!lastCheckedPriceStr) {
      alert.lastCheckedPrice = currentPriceStr;
      return false;
    }

    const lastPrice = new Decimal(lastCheckedPriceStr);
    let isTriggered = false;

    if (alert.condition === 'ABOVE') {
      if (lastPrice.lt(targetPrice) && currentPrice.gte(targetPrice)) {
        isTriggered = true;
      }
    } else if (alert.condition === 'BELOW') {
      if (lastPrice.gt(targetPrice) && currentPrice.lte(targetPrice)) {
        isTriggered = true;
      }
    }

    let statusChanged = false;

    if (isTriggered) {
      alert.triggeredAt = Date.now();
      alert.lastTriggeredAt = Date.now();

      if (alert.repeat === 'ONCE') {
        alert.status = 'TRIGGERED';
      }

      this.notifyTrigger({
        alertId: alert.id,
        symbol: alert.symbol,
        condition: alert.condition,
        targetPrice: alert.targetPrice,
        triggerPrice: currentPriceStr,
        triggeredAt: alert.triggeredAt,
      });
      statusChanged = true;
    }

    if (alert.lastCheckedPrice !== currentPriceStr) {
      alert.lastCheckedPrice = currentPriceStr;
      statusChanged = true;
    }

    return statusChanged || isTriggered;
  }

  public evaluateAllAlerts = () => {
    this.onTickerUpdate();
  };

  private onTickerUpdate = () => {
    const tickers = tickerService.getAllTickers();
    if (tickers.length === 0) return;

    const pricesBySymbol = new Map<string, string>();
    tickers.forEach((t) => pricesBySymbol.set(t.symbol, t.lastPrice));

    let updated = false;

    this.alerts.forEach((alert) => {
      if (alert.status !== 'ACTIVE') return;

      const currentPriceStr = pricesBySymbol.get(alert.symbol);
      if (!currentPriceStr) return; // No price data for this symbol yet

      const changed = this.evaluateAlert(alert, currentPriceStr);
      if (changed) {
        updated = true;
      }
    });

    if (updated) {
      this.save();
    }
  };
}

export const priceAlertService = new PriceAlertService();
