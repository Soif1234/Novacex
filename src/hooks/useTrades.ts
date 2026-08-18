import { useState, useEffect } from 'react';
import { tradeService } from '../services/TradeService';
import { DemoTrade } from '../types/trades';

export function useTrades(accountId: string = 'demo-user-1') {
  const [trades, setTrades] = useState<DemoTrade[]>(tradeService.getTradesByAccount(accountId));

  useEffect(() => {
    return tradeService.subscribe(() => {
      setTrades(tradeService.getTradesByAccount(accountId));
    });
  }, [accountId]);

  return { trades, tradeService };
}
