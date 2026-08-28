import { Decimal } from 'decimal.js';
import { Asset, WalletBalances } from './types';
import { apiClient } from '../api/client';
import { WalletBalancesMap } from '../api/types';

export class WalletService {
  public async getAssets(accountId?: string): Promise<Asset[]> {
    if (typeof window === 'undefined') {
      return []; // SSR safe
    }
    const backendRes = await apiClient.get<any>('/wallet/balances', accountId ? { accountId } : undefined);
    const backendBalances: WalletBalancesMap = backendRes?.balances || backendRes;
    if (!backendBalances || typeof backendBalances !== 'object' || Object.keys(backendBalances).length === 0) {
      return [];
    }
    return this.mapBackendBalancesToAssets(backendBalances);
  }

  public async getWalletBalances(accountId?: string): Promise<WalletBalances> {
    const assets = await this.getAssets(accountId);
    const spotUsdtAsset = assets.find(a => a.asset === 'USDT') || this.createEmptyAsset('USDT');
    const futuresUsdtAsset = assets.find(a => a.asset === 'FUTURES_USDT') || this.createEmptyAsset('FUTURES_USDT');

    // Calculate Spot Total across all assets
    let spotTotal = new Decimal(0);
    for (const asset of assets) {
      if (asset.asset !== 'FUTURES_USDT') {
        spotTotal = spotTotal.plus(new Decimal(asset.marketValue));
      }
    }

    let futuresPositions: any[] = [];
    try {
      const posRes = await apiClient.get<any>('/futures/positions', accountId ? { accountId } : undefined);
      futuresPositions = Array.isArray(posRes) ? posRes : (posRes?.data || []);
    } catch (err) {
      console.warn('Failed to fetch positions for PnL', err);
    }
    
    let unrealizedPnl = new Decimal(0);
    for (const p of futuresPositions) {
      if (p.status === 'OPEN') {
        unrealizedPnl = unrealizedPnl.plus(new Decimal(p.unrealizedPnl || '0'));
      }
    }

    const futuresTotal = new Decimal(futuresUsdtAsset.totalBalance).plus(unrealizedPnl);
    const total = spotTotal.plus(futuresTotal);

    return {
      total: total.toString(),
      spotTotal: spotTotal.toString(),
      futuresTotal: futuresTotal.toString(),
      spotAvailable: spotUsdtAsset.availableBalance,
      futuresAvailable: futuresUsdtAsset.availableBalance,
      spotLocked: spotUsdtAsset.lockedBalance,
      futuresLocked: futuresUsdtAsset.lockedBalance,
      unrealizedPnl: unrealizedPnl.toString()
    };
  }

  private mapBackendBalancesToAssets(balancesMap: WalletBalancesMap): Asset[] {
    const assets: Asset[] = [];
    for (const [symbol, b] of Object.entries(balancesMap)) {
      assets.push({
        asset: symbol,
        name: this.getAssetName(symbol),
        totalBalance: b.total,
        availableBalance: b.available,
        lockedBalance: b.locked,
        marketValue: b.total, // baseline value in USD/USDT
        status: 'ACTIVE'
      });
    }
    return assets;
  }

  private createEmptyAsset(symbol: string): Asset {
    return {
      asset: symbol,
      name: this.getAssetName(symbol),
      totalBalance: '0',
      availableBalance: '0',
      lockedBalance: '0',
      marketValue: '0',
      status: 'ACTIVE'
    };
  }

  private getAssetName(symbol: string): string {
    if (symbol === 'FUTURES_USDT') return 'Tether US (Futures)';
    const map: Record<string, string> = {
      USDT: 'Tether US',
      USDC: 'USD Coin',
      BTC: 'Bitcoin',
      ETH: 'Ethereum',
      SOL: 'Solana',
      XRP: 'Ripple',
      DOGE: 'Dogecoin',
      BNB: 'Binance Coin'
    };
    return map[symbol] || symbol;
  }
}

export const walletService = new WalletService();
