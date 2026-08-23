import { useState, useEffect } from 'react';
import { walletService } from '../services/wallet';
import { wsClient } from '../services/websocket/wsClient';

/**
 * Backend-authoritative balances keyed by asset symbol (total balance per asset).
 *
 * This replaces the former client-side demo ledger. Balances now ALWAYS originate
 * from the backend (`/wallet/balances`) and are refreshed on the `user:balances`
 * WebSocket event and on a periodic poll. No financial state is ever fabricated or
 * mutated on the client.
 */
export function useLedger(accountId: string = 'demo-user-1'): { balances: Record<string, string>; isLoading: boolean } {
  const [balances, setBalances] = useState<Record<string, string>>({});
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let mounted = true;

    const fetchBalances = async () => {
      try {
        const assets = await walletService.getAssets(accountId);
        if (!mounted) return;
        const map: Record<string, string> = {};
        for (const a of assets) {
          map[a.asset] = a.totalBalance;
        }
        setBalances(map);
      } catch {
        // On failure, expose no balances rather than any fabricated/stale value.
        if (mounted) setBalances({});
      } finally {
        if (mounted) setIsLoading(false);
      }
    };

    fetchBalances();
    const unsubWs = wsClient.subscribe('user:balances', fetchBalances);
    const interval = setInterval(fetchBalances, 10000);

    return () => {
      mounted = false;
      unsubWs();
      clearInterval(interval);
    };
  }, [accountId]);

  return { balances, isLoading };
}
