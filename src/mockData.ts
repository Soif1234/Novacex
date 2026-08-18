import { Coin, MarketPair } from './types';

export const mockCoins: Coin[] = [
  { id: '1', symbol: 'BTC', name: 'Bitcoin', price: 64230.50,
    priceStr: "64230.50", change24h: 2.4, volume: 32450000000 },
  { id: '2', symbol: 'ETH', name: 'Ethereum', price: 3450.20,
    priceStr: "3450.20", change24h: -1.2, volume: 15230000000 },
  { id: '3', symbol: 'SOL', name: 'Solana', price: 145.80,
    priceStr: "145.80", change24h: 5.6, volume: 3450000000 },
  { id: '4', symbol: 'XRP', name: 'Ripple', price: 0.58,
    priceStr: "0.58", change24h: 0.5, volume: 1200000000 },
  { id: '5', symbol: 'DOGE', name: 'Dogecoin', price: 0.12,
    priceStr: "0.12", change24h: -3.4, volume: 890000000 },
];

export const mockMarkets: MarketPair[] = [
  { id: '1', baseAsset: 'BTC', quoteAsset: 'USDT', price: 64230.50,
    priceStr: "64230.50", change24h: 2.4, volume: 32450000000 },
  { id: '2', baseAsset: 'ETH', quoteAsset: 'USDT', price: 3450.20,
    priceStr: "3450.20", change24h: -1.2, volume: 15230000000 },
  { id: '3', baseAsset: 'SOL', quoteAsset: 'USDT', price: 145.80,
    priceStr: "145.80", change24h: 5.6, volume: 3450000000 },
  { id: '4', baseAsset: 'XRP', quoteAsset: 'USDT', price: 0.58,
    priceStr: "0.58", change24h: 0.5, volume: 1200000000 },
  { id: '5', baseAsset: 'DOGE', quoteAsset: 'USDT', price: 0.12,
    priceStr: "0.12", change24h: -3.4, volume: 890000000 },
  { id: '6', baseAsset: 'ADA', quoteAsset: 'USDT', price: 0.45,
    priceStr: "0.45", change24h: 1.1, volume: 560000000 },
  { id: '7', baseAsset: 'AVAX', quoteAsset: 'USDT', price: 35.20,
    priceStr: "35.20", change24h: -2.1, volume: 450000000 },
  { id: '8', baseAsset: 'LINK', quoteAsset: 'USDT', price: 14.50,
    priceStr: "14.50", change24h: 4.2, volume: 340000000 },
];
