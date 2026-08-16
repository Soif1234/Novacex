import { FuturesMarket } from '../../types/futures';
import { FUTURES_MARKETS, FuturesMarketConfig } from './FuturesMarketConfig';
import { fetchMarketData } from '../marketData';

export class FuturesMarketService {
  /**
   * Retrieves all futures markets by merging static configuration with live dynamic data.
   */
  public async getMarkets(): Promise<FuturesMarket[]> {
    const liveMarkets = await fetchMarketData();
    
    return FUTURES_MARKETS.map(config => {
      // Find matching live market for dynamic data
      const live = liveMarkets.find(m => m.baseAsset === config.baseAsset && m.quoteAsset === config.quoteAsset);
      
      return {
        ...config,
        lastPrice: live?.priceStr || '0',
        markPrice: live?.priceStr || '0',
        indexPrice: live?.priceStr || '0', // In demo, mark = index = spot
        fundingRate: '0.0001', // Mock 0.01%
        openInterest: '0',
        volume24h: live?.volume.toString() || '0',
        high24h: live?.high24h?.toString() || '0',
        low24h: live?.low24h?.toString() || '0',
        change24h: live?.change24h.toString() || '0',
      };
    });
  }

  /**
   * Gets a specific futures market by symbol.
   */
  public async getMarket(symbol: string): Promise<FuturesMarket | null> {
    if (!this.isValidSymbol(symbol)) return null;
    
    const markets = await this.getMarkets();
    return markets.find(m => m.symbol === symbol) || null;
  }

  /**
   * Gets the static configuration for a symbol.
   */
  public getMarketConfig(symbol: string): FuturesMarketConfig | null {
    return FUTURES_MARKETS.find(m => m.symbol === symbol) || null;
  }

  /**
   * Validates if a symbol is supported by the futures exchange.
   */
  public isValidSymbol(symbol: string): boolean {
    return FUTURES_MARKETS.some(m => m.symbol === symbol);
  }
}

export const futuresMarketService = new FuturesMarketService();
