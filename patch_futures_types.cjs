const fs = require('fs');
let content = fs.readFileSync('src/types/futures.ts', 'utf8');

const marketInterface = `export interface FuturesMarket {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  // Dynamic
  markPrice: string;
  indexPrice: string;
  fundingRate: string;
  openInterest: string;
  volume24h: string;
  high24h: string;
  low24h: string;
  change24h: string;
  // Static Config
  tickSize: string;
  quantityPrecision: number;
  minimumQuantity: string;
  maximumLeverage: number;
  makerFee: string;
  takerFee: string;
  maintenanceMarginRate: string;
}`;

content = content.replace(/export interface FuturesMarket \{[\s\S]*?\n\}/, marketInterface);
fs.writeFileSync('src/types/futures.ts', content);
