import { useState, useEffect } from 'react';
import { tickerService, Ticker } from '../services/market/TickerService';
import { wsClient } from '../services/websocket/wsClient';

let initialized = false;

export function useTicker(symbol?: string) {
  const [tickers, setTickers] = useState<Ticker[]>(tickerService.getAllTickers());
  const [liveTicker, setLiveTicker] = useState<Ticker | null>(null);
  
  useEffect(() => {
    if (!initialized) {
      initialized = true;
      tickerService.initialize();
    }
    
    const unsubscribe = tickerService.subscribe(() => {
      setTickers(tickerService.getAllTickers());
    });
    
    // Catch up in case data was populated before subscribe
    setTickers(tickerService.getAllTickers());
    
    let unsubWs = () => {};
    if (symbol) {
      unsubWs = wsClient.subscribe(`ticker:${symbol}`, (data: any) => {
        if (data && data.lastPrice) {
          setLiveTicker({
            symbol: data.symbol || symbol,
            lastPrice: data.lastPrice,
            priceChange: data.priceChange || '0',
            priceChangePercent: data.priceChangePercent || '0',
            high24h: data.high24h || data.lastPrice,
            low24h: data.low24h || data.lastPrice,
            volume24h: data.volume24h || '0',
            quoteVolume24h: data.quoteVolume24h || '0',
            timestamp: data.timestamp || Date.now(),
          });
        }
      });
    }

    return () => {
      unsubscribe();
      unsubWs();
    };
  }, [symbol]);

  if (symbol) {
    return liveTicker || tickers.find(t => t.symbol === symbol) || null;
  }
  
  return tickers;
}
