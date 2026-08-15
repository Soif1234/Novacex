export interface PortfolioAsset {
  symbol: string;
  balance: string; // available + locked
  available: string;
  locked: string;
  currentPrice: string;
  valueUsdt: string;
  avgEntryPrice: string;
  unrealizedPnl: string;
  realizedPnl: string;
  change24h: string;
}

export interface PortfolioStats {
  totalValue: string;
  totalUnrealizedPnl: string;
  totalRealizedPnl: string;
  assets: PortfolioAsset[];
  change24h: string;
  change24hPercent: string;
}
