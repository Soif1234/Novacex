import { FuturesMarket } from '../../types/futures';
import { tradingPairRegistry } from '../market/TradingPairRegistry';

export type FuturesMarketConfig = Pick<FuturesMarket, 
  'symbol' | 'baseAsset' | 'quoteAsset' | 'tickSize' | 'quantityPrecision' | 
  'minimumQuantity' | 'maximumLeverage' | 'makerFee' | 'takerFee' | 'maintenanceMarginRate'>;

export const FUTURES_MARKETS: FuturesMarketConfig[] = tradingPairRegistry.getFuturesPairs().map(pair => ({
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
