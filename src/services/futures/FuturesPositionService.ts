import { Decimal } from 'decimal.js';
import { FuturesPosition, PositionSide, MarginMode, PositionStatus } from '../../types/futures';
import { futuresRiskService } from './FuturesRiskService';

export class FuturesPositionService {
  /**
   * Calculates the unrealized PNL of a position based on its side, quantity, entry price, and current mark price.
   */
  public calculateUnrealizedPnl(
    side: PositionSide, 
    quantity: string | number, 
    entryPrice: string | number, 
    markPrice: string | number
  ): string {
    const q = new Decimal(quantity || 0);
    const ep = new Decimal(entryPrice || 0);
    const mp = new Decimal(markPrice || 0);

    if (q.lte(0)) return '0';

    if (side === 'LONG') {
      // (markPrice - entryPrice) * quantity
      return mp.minus(ep).mul(q).toString();
    } else {
      // (entryPrice - markPrice) * quantity
      return ep.minus(mp).mul(q).toString();
    }
  }

  /**
   * Calculates the position notional: quantity * current mark price
   */
  public calculatePositionNotional(quantity: string | number, price: string | number): string {
    return futuresRiskService.calculateNotional(quantity, price);
  }

  /**
   * Creates a new FuturesPosition object
   */
  public createPosition(params: {
    accountId: string;
    symbol: string;
    side: PositionSide;
    quantity: string;
    entryPrice: string;
    leverage: number;
    marginMode: MarginMode;
    maintenanceMarginRate: string;
  }): FuturesPosition {
    const { accountId, symbol, side, quantity, entryPrice, leverage, marginMode, maintenanceMarginRate } = params;
    
    const initialMargin = futuresRiskService.calculateInitialMargin(quantity, entryPrice, leverage);
    const maintenanceMargin = futuresRiskService.calculateMaintenanceMargin(quantity, entryPrice, maintenanceMarginRate);

    const now = Date.now();

    return {
      positionId: Math.random().toString(36).substring(2, 11),
      accountId,
      symbol,
      side,
      quantity: new Decimal(quantity).toString(),
      entryPrice: new Decimal(entryPrice).toString(),
      markPrice: new Decimal(entryPrice).toString(),
      leverage,
      marginMode,
      initialMargin,
      maintenanceMargin,
      unrealizedPnl: '0',
      realizedPnl: '0',
      liquidationPrice: '0', // Will be calculated by risk service later
      status: 'OPEN',
      createdAt: now,
      updatedAt: now
    };
  }

  /**
   * Increases a position's quantity and updates entry price (weighted average).
   */
  public increasePosition(
    position: FuturesPosition,
    addQuantity: string | number,
    addPrice: string | number,
    maintenanceMarginRate: string
  ): FuturesPosition {
    const qAdd = new Decimal(addQuantity || 0);
    const pAdd = new Decimal(addPrice || 0);

    if (qAdd.lte(0)) {
      return { ...position };
    }

    const currentQty = new Decimal(position.quantity);
    const currentPrice = new Decimal(position.entryPrice);

    // Calculate new total quantity
    const newQty = currentQty.plus(qAdd);

    // Calculate weighted average entry price
    // ((currentQty * currentPrice) + (addQty * addPrice)) / newQty
    const currentNotional = currentQty.mul(currentPrice);
    const addNotional = qAdd.mul(pAdd);
    const newEntryPrice = currentNotional.plus(addNotional).div(newQty);

    // Calculate new margins
    // Add required margin for the added quantity to the existing initial margin
    const addedRequiredMargin = futuresRiskService.calculateInitialMargin(qAdd.toString(), pAdd.toString(), position.leverage);
    const newInitialMargin = new Decimal(position.initialMargin).plus(addedRequiredMargin).toString();
    const newMaintenanceMargin = futuresRiskService.calculateMaintenanceMargin(newQty.toString(), newEntryPrice.toString(), maintenanceMarginRate);

    return {
      ...position,
      quantity: newQty.toString(),
      entryPrice: newEntryPrice.toString(),
      markPrice: pAdd.toString(),
      initialMargin: newInitialMargin,
      maintenanceMargin: newMaintenanceMargin,
      updatedAt: Date.now()
    };
  }

  /**
   * Reduces a position's quantity and calculates the realized PNL for the reduced amount.
   * Note: Reducing a position doesn't change the entry price.
   */
  public reducePosition(
    position: FuturesPosition,
    reduceQuantity: string | number,
    reducePrice: string | number,
    maintenanceMarginRate: string
  ): { updatedPosition: FuturesPosition; realizedPnl: string } {
    const qReduce = new Decimal(reduceQuantity || 0);
    const pReduce = new Decimal(reducePrice || 0);
    const currentQty = new Decimal(position.quantity);

    if (qReduce.lte(0) || currentQty.lte(0)) {
      return { updatedPosition: { ...position }, realizedPnl: '0' };
    }

    let actualReduceQty = qReduce;
    if (qReduce.gte(currentQty)) {
      actualReduceQty = currentQty; // Cannot reduce more than current quantity
    }

    // Realized PNL for the reduced quantity
    const realizedPnlDelta = this.calculateRealizedPnl(
      position.side,
      actualReduceQty.toString(),
      position.entryPrice,
      pReduce.toString()
    );

    const newQty = currentQty.minus(actualReduceQty);
    
    let status: PositionStatus = 'OPEN';
    let newInitialMargin = '0';
    let newMaintenanceMargin = '0';
    
    if (newQty.gt(0)) {
      // Proportionally reduce initial margin
      const ratio = newQty.div(currentQty);
      newInitialMargin = new Decimal(position.initialMargin).mul(ratio).toString();
      newMaintenanceMargin = futuresRiskService.calculateMaintenanceMargin(newQty.toString(), position.entryPrice, maintenanceMarginRate);
    } else {
      status = 'CLOSED';
    }

    const currentRealized = new Decimal(position.realizedPnl || '0');
    const newRealizedPnlTotal = currentRealized.plus(new Decimal(realizedPnlDelta));

    const updatedPosition: FuturesPosition = {
      ...position,
      quantity: newQty.toString(),
      markPrice: pReduce.toString(),
      initialMargin: newInitialMargin,
      maintenanceMargin: newMaintenanceMargin,
      realizedPnl: newRealizedPnlTotal.toString(),
      status,
      updatedAt: Date.now()
    };

    return {
      updatedPosition,
      realizedPnl: realizedPnlDelta
    };
  }

  /**
   * Calculate Realized PNL for a specific quantity being closed.
   */
  public calculateRealizedPnl(
    side: PositionSide,
    closeQuantity: string | number,
    entryPrice: string | number,
    closePrice: string | number
  ): string {
    const q = new Decimal(closeQuantity || 0);
    const ep = new Decimal(entryPrice || 0);
    const cp = new Decimal(closePrice || 0);

    if (q.lte(0)) return '0';

    if (side === 'LONG') {
      // (closePrice - entryPrice) * closeQuantity
      return cp.minus(ep).mul(q).toString();
    } else {
      // (entryPrice - closePrice) * closeQuantity
      return ep.minus(cp).mul(q).toString();
    }
  }
}

export const futuresPositionService = new FuturesPositionService();
