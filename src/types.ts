export interface Coin {
  id: string;
  symbol: string;
  name: string;
  price: number;
  priceStr: string;
  change24h: number;
  volume: number;
}

export interface MarketPair {
  id: string;
  baseAsset: string;
  quoteAsset: string;
  price: number;
  priceStr: string;
  change24h: number;
  volume: number;
  high24h?: number;
  low24h?: number;
}

export interface Order {
  id: string;
  pair: string;
  type: 'buy' | 'sell';
  price: number;
  amount: number;
  status: 'open' | 'filled' | 'canceled';
  date: string;
}

export interface Position {
  id: string;
  pair: string;
  type: 'long' | 'short';
  leverage: number;
  marginType: 'isolated' | 'cross';
  entryPrice: number;
  markPrice: number;
  liquidationPrice: number;
  margin: number;
  unrealizedPnl: number;
}
