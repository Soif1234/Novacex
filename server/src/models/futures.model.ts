export type PositionSide = 'LONG' | 'SHORT';
export type PositionStatus = 'OPEN' | 'CLOSED' | 'LIQUIDATED';
export type MarginMode = 'ISOLATED' | 'CROSS';

export interface FuturesPositionEntity {
  id: string;
  accountId: string;
  symbol: string;
  side: PositionSide;
  quantity: string;
  entryPrice: string;
  markPrice: string;
  liquidationPrice: string;
  leverage: number;
  marginMode: MarginMode;
  initialMargin: string;
  maintenanceMargin: string;
  realizedPnl: string;
  status: PositionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface FuturesOrderEntity {
  id: string;
  orderId: string;
  accountId: string;
  symbol: string;
  positionSide: PositionSide;
  leverage: number;
  marginMode: MarginMode;
  reduceOnly: boolean;
  closePosition: boolean;
  createdAt: Date;
}

export interface FuturesTpSlConfigEntity {
  id: string;
  positionId: string;
  accountId: string;
  symbol: string;
  positionSide: PositionSide;
  takeProfitEnabled: boolean;
  takeProfitPrice?: string;
  stopLossEnabled: boolean;
  stopLossPrice?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface FuturesFundingHistoryEntity {
  id: string;
  symbol: string;
  fundingRate: string;
  markPrice: string;
  indexPrice?: string;
  settledAt: Date;
}

export interface FuturesLiquidationEntity {
  id: string;
  positionId: string;
  accountId: string;
  symbol: string;
  side: PositionSide;
  quantity: string;
  bankruptcyPrice: string;
  liquidationPrice: string;
  lossAmount: string;
  insuranceFundDelta: string;
  createdAt: Date;
}
