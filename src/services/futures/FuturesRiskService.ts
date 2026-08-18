import { Decimal } from 'decimal.js';
import { FuturesPosition, FuturesMarket } from '../../types/futures';

const ALLOWED_LEVERAGES = [1, 2, 3, 5, 10, 20];

export class FuturesRiskService {
  /**
   * Validate if the leverage is within the allowed options
   */
  public isValidLeverage(leverage: number): boolean {
    return ALLOWED_LEVERAGES.includes(leverage);
  }

  /**
   * Calculate Position Notional = Quantity * Price
   */
  public calculateNotional(quantity: string | number, price: string | number): string {
    const q = new Decimal(quantity || 0);
    const p = new Decimal(price || 0);
    if (q.lte(0) || p.lte(0)) {
      return '0';
    }
    return q.mul(p).toString();
  }

  /**
   * Calculate Initial Margin = Position Notional / Leverage
   */
  public calculateInitialMargin(quantity: string | number, price: string | number, leverage: number): string {
    if (!this.isValidLeverage(leverage)) {
      throw new Error(`Invalid leverage: ${leverage}`);
    }
    const notional = new Decimal(this.calculateNotional(quantity, price));
    
    if (notional.lte(0)) {
      return '0';
    }
    return notional.div(leverage).toString();
  }

  /**
   * Calculate Maintenance Margin = Position Notional * MMR
   */
  public calculateMaintenanceMargin(quantity: string | number, price: string | number, maintenanceMarginRate: string | number): string {
    const notional = new Decimal(this.calculateNotional(quantity, price));
    const mmr = new Decimal(maintenanceMarginRate || 0);
    if (notional.lte(0) || mmr.lte(0)) {
      return '0';
    }
    return notional.mul(mmr).toString();
  }

  /**
   * Check if available margin is sufficient for the required initial margin
   */
  public hasSufficientMargin(availableMargin: string | number, requiredMargin: string | number): boolean {
    const available = new Decimal(availableMargin || 0);
    const required = new Decimal(requiredMargin || 0);
    
    if (required.lte(0)) return false; 
    
    return available.gte(required);
  }

  public calculateUnrealizedPnl(position: FuturesPosition, markPrice: string | number): string {
    const q = new Decimal(position.quantity || 0);
    const ep = new Decimal(position.entryPrice || 0);
    const mp = new Decimal(markPrice || 0);

    if (q.lte(0)) return '0';

    if (position.side === 'LONG') {
      return mp.minus(ep).mul(q).toString();
    } else {
      return ep.minus(mp).mul(q).toString();
    }
  }

  public calculateNetPnl(position: FuturesPosition, markPrice: string | number): string {
    const grossPnl = new Decimal(this.calculateUnrealizedPnl(position, markPrice));
    const realizedPnl = new Decimal(position.realizedPnl || 0);
    const cumulativeFee = new Decimal(position.cumulativeFee || 0);
    const cumulativeFunding = new Decimal(position.cumulativeFunding || 0); // Note: funding paid is negative, received is positive
    
    // Net PNL = Unrealized PNL + Realized PNL - cumulative fees + cumulative funding
    // Wait, the UI might show Net PNL just for the open portion or total for the position? 
    // Usually it's total for the position (including realized if not closed out entirely yet).
    // Let's stick to: Net PNL = Gross PNL + cumulativeFunding - cumulativeFee (ignoring realized PNL from partial closes for now, or including it?)
    // Actually, Realized PNL is from partial closes. 
    return grossPnl.plus(realizedPnl).minus(cumulativeFee).plus(cumulativeFunding).toString();
  }

  public calculateRoe(unrealizedPnl: string | number, initialMargin: string | number): string {
    const upnl = new Decimal(unrealizedPnl || 0);
    const im = new Decimal(initialMargin || 0);
    
    if (im.lte(0)) return '0';
    
    return upnl.div(im).mul(100).toString();
  }

  /**
   * Calculate Position Equity
   * ISOLATED: Initial Margin + UPNL
   * CROSS: Available Margin + Initial Margin + UPNL
   */
  public calculatePositionEquity(
    position: FuturesPosition,
    availableMargin: string | number = '0'
  ): string {
    const im = new Decimal(position.initialMargin || 0);
    const upnl = new Decimal(position.unrealizedPnl || 0);
    
    if (position.marginMode === 'ISOLATED') {
      return im.plus(upnl).toString();
    } else {
      const am = new Decimal(availableMargin || 0);
      return am.plus(im).plus(upnl).toString();
    }
  }

  /**
   * Calculate Margin Ratio = Maintenance Margin / Position Equity
   */
  public calculateMarginRatio(
    maintenanceMargin: string | number,
    positionEquity: string | number
  ): string {
    const mm = new Decimal(maintenanceMargin || 0);
    const eq = new Decimal(positionEquity || 0);
    
    if (eq.lte(0)) return '1'; // 100% or Infinity if equity is zero or negative. We return 1 as a representation of 100% risk.
    if (mm.lte(0)) return '0';

    return mm.div(eq).toString();
  }

  /**
   * Calculate exact Liquidation Price
   *
   * ISOLATED LONG: LP = EP + (MM - IM) / QTY
   * ISOLATED SHORT: LP = EP + (IM - MM) / QTY
   * CROSS LONG: LP = (EP * QTY - IM - AM) / (QTY * (1 - MMR))
   * CROSS SHORT: LP = (EP * QTY + IM + AM) / (QTY * (1 + MMR))
   */
  public calculateLiquidationPrice(
    position: FuturesPosition,
    maintenanceMarginRate: string | number,
    availableMargin: string | number = '0'
  ): string {
    const ep = new Decimal(position.entryPrice || 0);
    const q = new Decimal(position.quantity || 0);
    const im = new Decimal(position.initialMargin || 0);
    const mm = new Decimal(position.maintenanceMargin || 0);
    const am = new Decimal(availableMargin || 0);
    const mmr = new Decimal(maintenanceMarginRate || 0);

    if (q.lte(0) || ep.lte(0)) return '0';

    if (position.marginMode === 'ISOLATED') {
      if (position.side === 'LONG') {
        // LP = EP + (MM - IM) / QTY
        const lp = ep.plus(mm.minus(im).div(q));
        return lp.lt(0) ? '0' : lp.toString();
      } else {
        // LP = EP + (IM - MM) / QTY
        const lp = ep.plus(im.minus(mm).div(q));
        return lp.lt(0) ? '0' : lp.toString();
      }
    } else {
      // CROSS MARGIN
      if (position.side === 'LONG') {
        // LP = (EP * QTY - IM - AM) / (QTY * (1 - MMR))
        const num = ep.mul(q).minus(im).minus(am);
        const den = q.mul(new Decimal(1).minus(mmr));
        if (den.lte(0)) return '0';
        const lp = num.div(den);
        return lp.lt(0) ? '0' : lp.toString();
      } else {
        // LP = (EP * QTY + IM + AM) / (QTY * (1 + MMR))
        const num = ep.mul(q).plus(im).plus(am);
        const den = q.mul(new Decimal(1).plus(mmr));
        if (den.lte(0)) return '0';
        const lp = num.div(den);
        return lp.lt(0) ? '0' : lp.toString();
      }
    }
  }

  /**
   * Check if a position is eligible for liquidation.
   * Condition: Equity < Maintenance Margin
   */
  public checkLiquidation(
    position: FuturesPosition,
    availableMargin: string | number = '0'
  ): boolean {
    const eq = new Decimal(this.calculatePositionEquity(position, availableMargin));
    const mm = new Decimal(position.maintenanceMargin || 0);

    return eq.lt(mm);
  }

  /**
   * Determine UI Risk Status
   * SAFE: Ratio < 0.6
   * WARNING: Ratio >= 0.6 and < 0.9
   * LIQUIDATION_RISK: Ratio >= 0.9
   */
  public getRiskStatus(marginRatio: string | number): 'SAFE' | 'WARNING' | 'LIQUIDATION_RISK' {
    const mr = new Decimal(marginRatio || 0);
    if (mr.gte(0.9)) return 'LIQUIDATION_RISK';
    if (mr.gte(0.6)) return 'WARNING';
    return 'SAFE';
  }
}

export const futuresRiskService = new FuturesRiskService();
