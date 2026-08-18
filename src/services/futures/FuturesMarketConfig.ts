import { FuturesMarket } from '../../types/futures';
import { tradingPairRegistry } from '../market/TradingPairRegistry';

export type FuturesMarketConfig = Pick<FuturesMarket, 
  'symbol' | 'baseAsset' | 'quoteAsset' | 'tickSize' | 'quantityPrecision' | 
  'minimumQuantity' | 'maximumLeverage' | 'makerFee' | 'takerFee' | 'maintenanceMarginRate'>;

export function getFuturesMarketConfigs(): FuturesMarketConfig[] {
  return tradingPairRegistry.getFuturesPairs().map(pair => ({
    symbol: pair.symbol,
    baseAsset: pair.baseAsset,
    quoteAsset: pair.quoteAsset,
    tickSize: pair.tickSize,
    quantityPrecision: pair.quantityPrecision,
    minimumQuantity: pair.minQuantity,
    maximumLeverage: pair.symbol === 'BTCUSDT' ? 125 : pair.symbol === 'ETHUSDT' ? 100 : 50,
    makerFee: '0.0002',
    takerFee: '0.0005',
    maintenanceMarginRate: pair.symbol === 'BTCUSDT' || pair.symbol === 'ETHUSDT' ? '0.005' : '0.01',
  }));
}

export const FUTURES_MARKETS: FuturesMarketConfig[] = new Proxy([] as FuturesMarketConfig[], {
  get(target, prop, receiver) {
    const fresh = getFuturesMarketConfigs();
    if (prop === 'length') return fresh.length;
    if (typeof prop === 'string' && !isNaN(Number(prop))) {
      return fresh[Number(prop)];
    }
    const val = (fresh as any)[prop];
    if (typeof val === 'function') {
      return val.bind(fresh);
    }
    return val;
  }
});
