import { useState, useEffect } from 'react';
import { portfolioService } from '../services/PortfolioService';
import { PortfolioStats } from '../types/portfolio';

export function usePortfolio(accountId: string = 'demo-user-1') {
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
            
    // Also poll every 10s to update based on market prices
    const interval = setInterval(fetchStats, 10000);

    return () => {
      isMounted = false;
                        clearInterval(interval);
    };
  }, [accountId]);

  return { stats, isLoading };
}
