import { useState, useEffect } from 'react';
import { walletService, Asset, WalletBalances } from '../services/wallet';
import { wsClient } from '../services/websocket/wsClient';

export function useWallet(accountId?: string) {
  const [assets, setAssets] = useState<Asset[]>([]);
  const [balances, setBalances] = useState<WalletBalances | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
          setError(null);
        }
      } catch (e) {
        console.error('Failed to fetch wallet stats', e);
        if (isMounted) {
          setAssets([]);
          setBalances(null);
          setError('Failed to load balances');
        }
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    
    fetchWallet();

                    const unsubWs = wsClient.subscribe('user:balances', fetchWallet);
    
    const interval = setInterval(fetchWallet, 10000);

    return () => {
      isMounted = false;
                              unsubWs();
      clearInterval(interval);
    };
  }, [accountId]);

  return { assets, balances, isLoading, error };
}
