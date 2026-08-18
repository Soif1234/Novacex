import { DemoLedger } from './ledger';
import { fetchMarketData } from './marketData';
import { Decimal } from 'decimal.js';
import { OrderService } from './OrderService';
import { TradeService } from './TradeService';
import { PortfolioStats, PortfolioAsset } from '../types/portfolio';

export class PortfolioService {
  constructor(
    private ledger: DemoLedger, 
    private orderSvc: OrderService,
    private tradeSvc: TradeService
  ) {}

  public async getPortfolioValueUSDT(accountId: string = 'demo-user-1'): Promise<string> {
    const stats = await this.getPortfolioStats(accountId);
    return stats.totalValue;
  }

  public async getPortfolioStats(accountId: string): Promise<PortfolioStats> {
    const balances = this.ledger.getAllBalances();
    const trades = this.tradeSvc.getTradesByAccount(accountId).slice().reverse();
    const pendingOrders = this.orderSvc.getPendingOrders().filter(o => o.accountId === accountId);
    let markets;
    try {
      markets = await fetchMarketData();
    } catch (e) {
      console.warn('Failed to fetch market data for portfolio valuation', e);
      markets = [];
    }

    // 1. Reconstruct positions for PNL tracking
    const positionState = new Map<string, { amount: Decimal, totalCost: Decimal, realizedPnl: Decimal }>();
    
    for (const trade of trades) {
      const baseAsset = trade.symbol.replace('USDT', '');
      if (!positionState.has(baseAsset)) {
        positionState.set(baseAsset, { amount: new Decimal(0), totalCost: new Decimal(0), realizedPnl: new Decimal(0) });
      }
      const pos = positionState.get(baseAsset)!;
      const qty = new Decimal(trade.quantity);
      const price = new Decimal(trade.price);
      
      if (trade.side === 'BUY') {
        pos.amount = pos.amount.plus(qty);
        pos.totalCost = pos.totalCost.plus(qty.mul(price));
      } else { // SELL
        const avgEntry = pos.amount.gt(0) ? pos.totalCost.div(pos.amount) : new Decimal(0);
        const pnl = price.minus(avgEntry).mul(qty);
        pos.realizedPnl = pos.realizedPnl.plus(pnl);
        
        pos.amount = pos.amount.minus(qty);
        pos.totalCost = pos.amount.gt(0) ? pos.amount.mul(avgEntry) : new Decimal(0);
        
        // Prevent negative amounts in tracking due to precision / shorts
        if (pos.amount.lte(0)) {
          pos.amount = new Decimal(0);
          pos.totalCost = new Decimal(0);
        }
      }
    }

    // 2. Build Asset list
    const assets: PortfolioAsset[] = [];
    let totalValue = new Decimal(0);
    let totalUnrealizedPnl = new Decimal(0);
    let totalRealizedPnl = new Decimal(0);
    let totalPastValue = new Decimal(0); // For 24h calculation

    const allAssets = new Set([
      ...Object.keys(balances), 
      ...pendingOrders.map(o => o.symbol.replace('USDT', ''))
    ]);

    for (const asset of allAssets) {
      if (asset === 'USDT') {
        let available = new Decimal(balances['USDT'] || '0');
        let locked = new Decimal(0);
        for (const order of pendingOrders) {
          if (order.side === 'BUY') {
            locked = locked.plus(new Decimal(order.quantity).mul(new Decimal(order.price!)));
          }
        }
        const balance = available.plus(locked);
        if (balance.gt(0)) {
          assets.push({
            symbol: 'USDT',
            balance: balance.toString(),
            available: available.toString(),
            locked: locked.toString(),
            currentPrice: '1',
            valueUsdt: balance.toString(),
            avgEntryPrice: '1',
            unrealizedPnl: '0',
            realizedPnl: '0',
            change24h: '0'
          });
          totalValue = totalValue.plus(balance);
          totalPastValue = totalPastValue.plus(balance);
        }
        continue;
      }

      const market = markets.find(m => m.baseAsset === asset);
      const currentPrice = market ? new Decimal(market.price) : new Decimal(0);
      const change24hPercent = market ? market.change24h : 0;
      
      let available = new Decimal(balances[asset] || '0');
      let locked = new Decimal(0);
      for (const order of pendingOrders) {
        if (order.side === 'SELL' && order.symbol.replace('USDT', '') === asset) {
          locked = locked.plus(new Decimal(order.quantity));
        }
      }
      
      const balance = available.plus(locked);
      const pos = positionState.get(asset) || { amount: new Decimal(0), totalCost: new Decimal(0), realizedPnl: new Decimal(0) };
      
      // Assume any balance not acquired via trading (e.g. deposit) has cost basis 0
      // But we'll try to match it to position state.
      const avgEntry = pos.amount.gt(0) ? pos.totalCost.div(pos.amount) : new Decimal(0);
      
      const valueUsdt = balance.mul(currentPrice);
      // Unrealized PNL applies to current total balance.
      const unrealizedPnl = balance.gt(0) ? currentPrice.minus(avgEntry).mul(balance) : new Decimal(0);
      
      if (balance.gt(0) || pos.realizedPnl.abs().gt(0.000001)) {
        assets.push({
          symbol: asset,
          balance: balance.toString(),
          available: available.toString(),
          locked: locked.toString(),
          currentPrice: currentPrice.toString(),
          valueUsdt: valueUsdt.toString(),
          avgEntryPrice: avgEntry.toString(),
          unrealizedPnl: unrealizedPnl.toString(),
          realizedPnl: pos.realizedPnl.toString(),
          change24h: change24hPercent.toString()
        });
        totalValue = totalValue.plus(valueUsdt);
        totalUnrealizedPnl = totalUnrealizedPnl.plus(unrealizedPnl);
        totalRealizedPnl = totalRealizedPnl.plus(pos.realizedPnl);
        
        // Back-calculate what this asset was worth 24h ago
        if (market) {
          const price24hAgo = currentPrice.div(1 + (change24hPercent / 100));
          totalPastValue = totalPastValue.plus(balance.mul(price24hAgo));
        }
      }
    }

    let overallChange24hPercent = new Decimal(0);
    let overallChange24hValue = new Decimal(0);
    
    if (totalPastValue.gt(0)) {
      overallChange24hValue = totalValue.minus(totalPastValue);
      overallChange24hPercent = overallChange24hValue.div(totalPastValue).mul(100);
    }

    return {
      totalValue: totalValue.toString(),
      totalUnrealizedPnl: totalUnrealizedPnl.toString(),
      totalRealizedPnl: totalRealizedPnl.toString(),
      assets,
      change24h: overallChange24hValue.toString(),
      change24hPercent: overallChange24hPercent.toString()
    };
  }
}

// We will inject the existing singletons
import { demoLedger } from './ledger';
import { orderService } from './OrderService';
import { tradeService } from './TradeService';
export const portfolioService = new PortfolioService(demoLedger, orderService, tradeService);
