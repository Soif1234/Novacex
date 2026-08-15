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
    const symbols = '["BTCUSDT","ETHUSDT","SOLUSDT","XRPUSDT","DOGEUSDT"]';
    const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(symbols)}`);
    
    if (!response.ok) {
      throw new Error(`API error: ${response.status}`);
    }

    const data: BinanceTickerResponse[] = await response.json();
    
    return data.map((item, index) => {
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
