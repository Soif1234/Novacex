import { useState, useEffect } from 'react';
import { tradeService } from '../services/TradeService';
import { DemoTrade } from '../types/trades';
import { wsClient } from '../services/websocket/wsClient';

export function useTrades(accountId: string = 'demo-user-1') {
  const [trades, setTrades] = useState<DemoTrade[]>(tradeService.getTradesByAccount(accountId));

  useEffect(() => {
    const unsubTrade = tradeService.subscribe(() => {
      setTrades(tradeService.getTradesByAccount(accountId));
    });

    const unsubWs = wsClient.subscribe('user:trades', () => {
      setTrades(tradeService.getTradesByAccount(accountId));
    });

    return () => {
      unsubTrade();
      unsubWs();
    };
  }, [accountId]);

  return { trades, tradeService };
}
