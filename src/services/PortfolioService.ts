import { fetchMarketData } from './marketData';
import { Decimal } from 'decimal.js';
import { PortfolioStats, PortfolioAsset } from '../types/portfolio';
import { apiClient } from './api/client';
import { walletService } from './wallet/WalletService';

export class PortfolioService {
  constructor() {}

  public async getPortfolioValueUSDT(accountId: string = 'demo-user-1'): Promise<string> {
    const stats = await this.getPortfolioStats(accountId);
    return stats.totalValue;
  }

  public async getPortfolioStats(accountId: string): Promise<PortfolioStats> {
    try {
      // Very basic implementation using walletService
      const balances = await walletService.getWalletBalances(accountId);
      return {
        totalValue: new Decimal(balances.spotTotal || '0').plus(balances.futuresTotal || '0').toString(),
        // totalAvailable: new Decimal(balances.spotAvailable || '0').plus(balances.futuresAvailable || '0').toString(),
      // @ts-ignore
      // @ts-ignore
        totalLocked: new Decimal(balances.spotLocked || '0').plus(balances.futuresLocked || '0').toString(),
        realizedPnL: '0',
        unrealizedPnL: '0',
        dayPnL: '0',
        dayPnLPercent: '0',
        recentTrades: [],
        assets: []
      };
    } catch(e) {
      console.warn('Failed to fetch portfolio stats', e);
      return {
        totalValue: '0',
      // @ts-ignore
        // totalAvailable: '0',
      // @ts-ignore
        totalLocked: '0',
        realizedPnL: '0',
        unrealizedPnL: '0',
        dayPnL: '0',
        dayPnLPercent: '0',
        recentTrades: [],
        assets: []
      };
    }
  }

  public getRealizedPnLHistory(accountId: string, days: number = 7): { date: string; amount: string }[] {
    return [];
  }
}

export const portfolioService = new PortfolioService();
