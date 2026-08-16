import { demoLedger } from '../ledger';
import { orderService } from '../OrderService';
import { futuresOrderService } from '../futures/FuturesOrderService';
import { futuresRiskService } from '../futures/FuturesRiskService';
import { Decimal } from 'decimal.js';
import { fetchMarketData } from '../marketData';
import { Asset, WalletBalances } from './types';

export class WalletService {
  public async getAssets(accountId: string = 'demo-account'): Promise<Asset[]> {
    const balances = demoLedger.getAllBalances();
    const spotOrders = orderService.getPendingOrders().filter(o => o.accountId === accountId);
    
    let markets: any[] = [];
    try {
      markets = await fetchMarketData();
    } catch (e) {}

    const assetsMap = new Map<string, Asset>();
    
    for (const [symbol, avail] of Object.entries(balances)) {
      assetsMap.set(symbol, {
        asset: symbol,
        name: this.getAssetName(symbol),
        totalBalance: avail,
        availableBalance: avail,
        lockedBalance: '0',
        marketValue: '0',
        status: 'ACTIVE'
      });
    }

    for (const order of spotOrders) {
      if (order.side === 'BUY') {
        const lockedQuote = new Decimal(order.quantity).mul(new Decimal(order.price!));
        const quoteAsset = 'USDT';
        if (!assetsMap.has(quoteAsset)) {
          assetsMap.set(quoteAsset, this.createEmptyAsset(quoteAsset));
        }
        const a = assetsMap.get(quoteAsset)!;
        a.lockedBalance = new Decimal(a.lockedBalance).plus(lockedQuote).toString();
        a.totalBalance = new Decimal(a.totalBalance).plus(lockedQuote).toString();
      } else {
        const baseAsset = order.symbol.replace('USDT', '');
        if (!assetsMap.has(baseAsset)) {
          assetsMap.set(baseAsset, this.createEmptyAsset(baseAsset));
        }
        const a = assetsMap.get(baseAsset)!;
        a.lockedBalance = new Decimal(a.lockedBalance).plus(order.quantity).toString();
        a.totalBalance = new Decimal(a.totalBalance).plus(order.quantity).toString();
      }
    }

    const futuresPositions = futuresOrderService.getPositions(accountId).filter(p => p.status === 'OPEN');
    const futuresOrders = futuresOrderService.getOrders(accountId).filter(o => o.status === 'PENDING');
    
    let futuresLockedUsdt = new Decimal(0);
    for (const pos of futuresPositions) {
      futuresLockedUsdt = futuresLockedUsdt.plus(new Decimal(pos.initialMargin));
    }
    
    for (const order of futuresOrders) {
      const isOpening = (order.side === 'BUY' && order.positionSide === 'LONG') || (order.side === 'SELL' && order.positionSide === 'SHORT');
      if ((order.type === 'LIMIT' || (order.type === 'STOP_LIMIT' && order.isTriggered)) && isOpening) {
         const reqMargin = futuresRiskService.calculateInitialMargin(order.quantity, order.price!, order.leverage);
         futuresLockedUsdt = futuresLockedUsdt.plus(new Decimal(reqMargin));
      }
    }

    if (futuresLockedUsdt.gt(0)) {
       const quoteAsset = 'FUTURES_USDT';
       if (!assetsMap.has(quoteAsset)) {
         assetsMap.set(quoteAsset, this.createEmptyAsset(quoteAsset));
       }
       const a = assetsMap.get(quoteAsset)!;
       a.lockedBalance = new Decimal(a.lockedBalance).plus(futuresLockedUsdt).toString();
       a.totalBalance = new Decimal(a.totalBalance).plus(futuresLockedUsdt).toString();
    }

    for (const [symbol, asset] of assetsMap.entries()) {
      if (symbol === 'USDT' || symbol === 'FUTURES_USDT') {
        asset.marketValue = asset.totalBalance;
      } else {
        const m = markets.find(x => x.baseAsset === symbol);
        const price = m ? m.price : '0';
        asset.marketValue = new Decimal(asset.totalBalance).mul(new Decimal(price)).toString();
      }
    }

    return Array.from(assetsMap.values()).filter(a => new Decimal(a.totalBalance).gt(0) || new Decimal(a.availableBalance).gt(0));
  }

  public async getWalletBalances(accountId: string = 'demo-account'): Promise<WalletBalances> {
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

    const futuresPositions = futuresOrderService.getPositions(accountId).filter(p => p.status === 'OPEN');
    let unrealizedPnl = new Decimal(0);
    for (const p of futuresPositions) {
      unrealizedPnl = unrealizedPnl.plus(new Decimal(p.unrealizedPnl || '0'));
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
      BTC: 'Bitcoin',
      ETH: 'Ethereum',
      SOL: 'Solana',
      XRP: 'Ripple',
      DOGE: 'Dogecoin'
    };
    return map[symbol] || symbol;
  }
}

export const walletService = new WalletService();
