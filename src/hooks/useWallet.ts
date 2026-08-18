import { useState, useEffect } from 'react';
import { walletService, Asset, WalletBalances } from '../services/wallet';
import { demoLedger } from '../services/ledger';
import { orderService } from '../services/OrderService';
import { futuresOrderService } from '../services/futures/FuturesOrderService';
import { tradeService } from '../services/TradeService';

export function useWallet(accountId: string = 'demo-user-1') {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    
    const fetchWallet = async () => {
      try {
        const [a, b] = await Promise.all([
          walletService.getAssets(accountId),
          walletService.getWalletBalances(accountId)
        ]);
        if (isMounted) {
          setAssets(a);
          setBalances(b);
        }
      } catch (e) {
        console.error('Failed to fetch wallet stats', e);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    
    fetchWallet();

    const unsubLedger = demoLedger.subscribe(fetchWallet);
    const unsubOrder = orderService.subscribe(fetchWallet);
    const unsubFutures = futuresOrderService.subscribe(fetchWallet);
    const unsubTrade = tradeService.subscribe(fetchWallet);
    
    const interval = setInterval(fetchWallet, 10000);

    return () => {
      isMounted = false;
      unsubLedger();
      unsubOrder();
      unsubFutures();
      unsubTrade();
      clearInterval(interval);
    };
  }, [accountId]);

  return { assets, balances, isLoading };
}
