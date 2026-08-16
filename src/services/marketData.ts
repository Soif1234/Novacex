import { tradingPairRegistry } from './market/TradingPairRegistry';
import { MarketPair } from '../types';
import { mockMarkets } from '../mockData';

// API Response type for Binance 24hr ticker
interface BinanceTickerResponse {
  symbol: string;
  lastPrice: string;
  priceChangePercent: string;
  quoteVolume: string;
  highPrice: string;
  lowPrice: string;
}

export async function fetchMarketData(): Promise<MarketPair[]> {
  try {
    const targetSymbols = tradingPairRegistry.getAllPairs().map(p => p.symbol);
    const symbols = JSON.stringify(targetSymbols);
    const response = await fetch(`https://fapi.binance.com/fapi/v1/ticker/24hr`);
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data: BinanceTickerResponse[] = await response.json();
    
    // targetSymbols already available
    const filteredData = data.filter((item: any) => targetSymbols.includes(item.symbol));
    return filteredData.map((item, index) => {
      // Assuming 'USDT' is always the quote asset for these pairs
      const baseAsset = item.symbol.replace('USDT', '');
      
      return {
        id: String(index + 1),
        baseAsset,
        quoteAsset: 'USDT',
        price: parseFloat(item.lastPrice),
        priceStr: item.lastPrice,
        change24h: parseFloat(item.priceChangePercent),
        volume: parseFloat(item.quoteVolume),
        high24h: parseFloat(item.highPrice),
        low24h: parseFloat(item.lowPrice),
      };
    });
  } catch (error) {
    console.warn('Failed to fetch real market data, falling back to mock data:', error);
    return mockMarkets.map(m => ({
      ...m,
      priceStr: m.price.toString(),
      high24h: m.price * 1.05,
      low24h: m.price * 0.95
    }));
  }
}
