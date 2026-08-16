const fs = require('fs');
let content = fs.readFileSync('src/types/futures.ts', 'utf8');

const positionInterface = `export type PositionStatus = 'OPEN' | 'CLOSED' | 'LIQUIDATED';

export interface FuturesPosition {
  positionId: string;
  accountId: string;
  symbol: string;
  side: PositionSide;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  leverage: number;
  marginMode: MarginMode;
  initialMargin: string;
  maintenanceMargin: string;
  unrealizedPnl: string;
  realizedPnl: string;
  liquidationPrice: string;
  status: PositionStatus;
  createdAt: number;
  updatedAt: number;
}`;

content = content.replace(/export interface FuturesPosition \{[\s\S]*?\n\}/, positionInterface);

// also update FuturesService and test to avoid errors
fs.writeFileSync('src/types/futures.ts', content);
