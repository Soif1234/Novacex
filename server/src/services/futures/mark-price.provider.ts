import { decimalNormalize } from '../ledger/decimal';

export interface IMarkPriceProvider {
  getMarkPrice(symbol: string): Promise<string>;
  setMarkPrice?(symbol: string, price: string): void;
}

/**
 * DevelopmentMarkPriceProvider
 * Authoritative deterministic mark price provider for paper/development trading and automated tests.
 * Clearly demarcated as development/testing only; no external production market data connections.
 */
export class DevelopmentMarkPriceProvider implements IMarkPriceProvider {
  private prices = new Map<string, string>([
    ['BTCUSDT', decimalNormalize('50000')],
    ['ETHUSDT', decimalNormalize('3000')],
    ['SOLUSDT', decimalNormalize('150')],
    ['BTCUSDC', decimalNormalize('50000')],
  ]);

  public async getMarkPrice(symbol: string): Promise<string> {
    const cleanSymbol = symbol.trim().toUpperCase();
    const p = this.prices.get(cleanSymbol);
    if (!p) {
      // Default fallback for any unseeded test symbol
      return decimalNormalize('50000');
    }
    return p;
  }

  public setMarkPrice(symbol: string, price: string): void {
    const cleanSymbol = symbol.trim().toUpperCase();
    this.prices.set(cleanSymbol, decimalNormalize(price));
  }

  public reset(): void {
    this.prices.set('BTCUSDT', decimalNormalize('50000'));
    this.prices.set('ETHUSDT', decimalNormalize('3000'));
    this.prices.set('SOLUSDT', decimalNormalize('150'));
    this.prices.set('BTCUSDC', decimalNormalize('50000'));
  }
}

export const developmentMarkPriceProvider = new DevelopmentMarkPriceProvider();
