export interface FuturesPosition {
  id: string;
  accountId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  leverage: number;
  size: string; // Quantity of base asset
  entryPrice: string;
  margin: string; // Initial margin locked in USDT
  liquidationPrice: string;
}

export interface FuturesCalculationResult {
  unrealizedPnl: string;
  pnlPercentage: string;
  marginRatio: string;
}
