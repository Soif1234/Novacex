import { useState, useEffect } from 'react';
import { tickerService, Ticker } from '../services/market/TickerService';

let initialized = false;

export function useTicker(symbol?: string) {
  const [tickers, setTickers] = useState<Ticker[]>(tickerService.getAllTickers());
  
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
    
    return unsubscribe;
  }, []);

  if (symbol) {
    return tickers.find(t => t.symbol === symbol) || null;
  }
  
  return tickers;
}
