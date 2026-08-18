import { FuturesMarket } from '../../types/futures';
import { FuturesMarketConfig, getFuturesMarketConfigs } from './FuturesMarketConfig';
import { fetchMarketData } from '../marketData';
import { tradingPairRegistry } from '../market/TradingPairRegistry';

export class FuturesMarketService {
  private overrides: Map<string, Partial<FuturesMarket>> = new Map();

  public setMarketOverride(symbol: string, data: Partial<FuturesMarket>) {
    this.overrides.set(symbol, data);
  }

  public clearOverrides() {
    this.overrides.clear();
  }

  /**
   * Retrieves all futures markets by merging static configuration with live dynamic data.
   */
  public async getMarkets(): Promise<FuturesMarket[]> {
    const configs = getFuturesMarketConfigs();
    const needsFetch = configs.some(c => !this.overrides.has(c.symbol));
    let liveMarkets: any[] = [];
    if (needsFetch) {
      liveMarkets = await fetchMarketData();
    }
    
    return configs.map(config => {
      const override = this.overrides.get(config.symbol);
      // Find matching live market for dynamic data
      const live = liveMarkets.find(m => m.baseAsset === config.baseAsset && m.quoteAsset === config.quoteAsset);
      
      return {
        ...config,
        lastPrice: override?.lastPrice || live?.priceStr || '0',
        markPrice: override?.markPrice || live?.priceStr || '0',
        indexPrice: override?.indexPrice || live?.priceStr || '0', // In demo, mark = index = spot
        fundingRate: override?.fundingRate || '0.0001', // Mock 0.01%
        openInterest: override?.openInterest || '0',
        volume24h: override?.volume24h || live?.volume?.toString() || '0',
        high24h: override?.high24h || live?.high24h?.toString() || '0',
        low24h: override?.low24h || live?.low24h?.toString() || '0',
        change24h: override?.change24h || live?.change24h?.toString() || '0',
      };
    });
  }

  /**
   * Gets a specific futures market by symbol.
   */
  public async getMarket(symbol: string): Promise<FuturesMarket | null> {
    if (!this.isValidSymbol(symbol)) return null;
    const override = this.overrides.get(symbol);
    if (override) {
      const config = this.getMarketConfig(symbol);
      if (!config) return null;
      return {
        ...config,
        lastPrice: override.lastPrice || '0',
        markPrice: override.markPrice || '0',
        indexPrice: override.indexPrice || '0',
        fundingRate: override.fundingRate || '0.0001',
        openInterest: override.openInterest || '0',
        volume24h: override.volume24h || '0',
        high24h: override.high24h || '0',
        low24h: override.low24h || '0',
        change24h: override.change24h || '0',
      };
    }
    
    const markets = await this.getMarkets();
    return markets.find(m => m.symbol === symbol) || null;
  }

  /**
   * Gets the static configuration for a symbol.
   */
  public getMarketConfig(symbol: string): FuturesMarketConfig | null {
    const configs = getFuturesMarketConfigs();
    return configs.find(m => m.symbol === symbol) || null;
  }

  /**
   * Validates if a symbol is supported by the futures exchange.
   */
  public isValidSymbol(symbol: string): boolean {
    const pair = tradingPairRegistry.getFuturesPair(symbol);
    return !!pair;
  }
}

export const futuresMarketService = new FuturesMarketService();
