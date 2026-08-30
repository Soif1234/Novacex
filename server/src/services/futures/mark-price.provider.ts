import { decimalNormalize } from '../ledger/decimal';

export interface IMarkPriceProvider {
  getMarkPrice(symbol: string): Promise<string>;
  getIndexPrice(symbol: string): Promise<string>;
  setMarkPrice?(symbol: string, price: string): void;
  setIndexPrice?(symbol: string, price: string): void;
}

/**
 * Fail-closed guard: the development mark price provider (static prices +
 * 50000 fallback for ANY unseeded symbol) must never drive risk decisions in
 * a production environment. If NODE_ENV is 'production', any price fetch from
 * this provider throws, halting liquidations/funding instead of fabricating
 * prices that could falsely liquidate positions.
 */
export function assertNotProduction(context: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      `[SECURITY] DevelopmentMarkPriceProvider is not a valid price source in production (${context}). ` +
      'Configure an authoritative market data provider before enabling futures risk operations.'
    );
  }
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
  
  private indexPrices = new Map<string, string>([
    ['BTCUSDT', decimalNormalize('50000')],
    ['ETHUSDT', decimalNormalize('3000')],
    ['SOLUSDT', decimalNormalize('150')],
    ['BTCUSDC', decimalNormalize('50000')],
  ]);

  public async getMarkPrice(symbol: string): Promise<string> {
    assertNotProduction(`getMarkPrice(${symbol})`);
    const cleanSymbol = symbol.trim().toUpperCase();
    const p = this.prices.get(cleanSymbol);
    if (!p) {
      // Default fallback for any unseeded test symbol
      return decimalNormalize('50000');
    }
    return p;
  }

  public async getIndexPrice(symbol: string): Promise<string> {
    assertNotProduction(`getIndexPrice(${symbol})`);
    const cleanSymbol = symbol.trim().toUpperCase();
    const p = this.indexPrices.get(cleanSymbol);
    if (!p) {
      return decimalNormalize('50000');
    }
    return p;
  }

  public setMarkPrice(symbol: string, price: string): void {
    const cleanSymbol = symbol.trim().toUpperCase();
    this.prices.set(cleanSymbol, decimalNormalize(price));
  }

  public setIndexPrice(symbol: string, price: string): void {
    const cleanSymbol = symbol.trim().toUpperCase();
    this.indexPrices.set(cleanSymbol, decimalNormalize(price));
  }

  public reset(): void {
    this.prices.set('BTCUSDT', decimalNormalize('50000'));
    this.prices.set('ETHUSDT', decimalNormalize('3000'));
    this.prices.set('SOLUSDT', decimalNormalize('150'));
    this.prices.set('BTCUSDC', decimalNormalize('50000'));
    this.indexPrices.set('BTCUSDT', decimalNormalize('50000'));
    this.indexPrices.set('ETHUSDT', decimalNormalize('3000'));
    this.indexPrices.set('SOLUSDT', decimalNormalize('150'));
    this.indexPrices.set('BTCUSDC', decimalNormalize('50000'));
  }
}

export const developmentMarkPriceProvider = new DevelopmentMarkPriceProvider();
