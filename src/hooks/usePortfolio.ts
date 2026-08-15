import { useState, useEffect } from 'react';
import { portfolioService } from '../services/PortfolioService';
import { PortfolioStats } from '../types/portfolio';
import { tradeService } from '../services/TradeService';
import { orderService } from '../services/OrderService';
import { demoLedger } from '../services/ledger';

export function usePortfolio(accountId: string = 'demo-account') {
  const [stats, setStats] = useState<PortfolioStats | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let isMounted = true;
    
    const fetchStats = async () => {
      try {
        const data = await portfolioService.getPortfolioStats(accountId);
        if (isMounted) {
          setStats(data);
        }
      } catch (err) {
        console.error('Failed to fetch portfolio stats', err);
      } finally {
        if (isMounted) setIsLoading(false);
      }
    };
    
    fetchStats();

    // Re-fetch on any ledger, order, or trade change
    const unsubLedger = demoLedger.subscribe(fetchStats);
    const unsubOrder = orderService.subscribe(fetchStats);
    const unsubTrade = tradeService.subscribe(fetchStats);

    // Also poll every 10s to update based on market prices
    const interval = setInterval(fetchStats, 10000);

    return () => {
      isMounted = false;
      unsubLedger();
      unsubOrder();
      unsubTrade();
      clearInterval(interval);
    };
  }, [accountId]);

  return { stats, isLoading };
}
