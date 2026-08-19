import { FuturesPositionEntity, PositionSide, MarginMode } from '../../models/futures.model';
import {
  decimalMultiply,
  decimalDivide,
  decimalSubtract,
  decimalAdd,
  decimalCompare,
  decimalNormalize,
  decimalZero,
} from '../ledger/decimal';
import { InvalidLeverageError } from './errors';

export const ALLOWED_FUTURES_LEVERAGES = [1, 2, 3, 5, 10, 20, 25, 50, 75, 100, 125];

export class FuturesRiskService {
  /**
   * Validate if leverage is within the allowed options and contract maximum.
   */
  public isValidLeverage(leverage: number, maxLeverage = 125): boolean {
    if (!Number.isInteger(leverage) || leverage < 1 || leverage > maxLeverage) {
      return false;
    }
    return ALLOWED_FUTURES_LEVERAGES.includes(leverage) || (leverage >= 1 && leverage <= maxLeverage);
  }

  /**
   * Calculate Position Notional = Quantity * Price
   */
  public calculateNotional(quantity: string, price: string): string {
    if (decimalCompare(quantity, '0') <= 0 || decimalCompare(price, '0') <= 0) {
      return decimalZero();
    }
    return decimalMultiply(quantity, price);
  }

  /**
   * Calculate Initial Margin = Position Notional / Leverage
   */
  public calculateInitialMargin(quantity: string, price: string, leverage: number): string {
    if (!this.isValidLeverage(leverage)) {
      throw new InvalidLeverageError(leverage);
    }
    const notional = this.calculateNotional(quantity, price);
    if (decimalCompare(notional, '0') <= 0) {
      return decimalZero();
    }
    return decimalDivide(notional, String(leverage));
  }

  /**
   * Calculate Maintenance Margin = Position Notional * MMR
   */
  public calculateMaintenanceMargin(quantity: string, price: string, maintenanceMarginRate: string): string {
    const notional = this.calculateNotional(quantity, price);
    if (decimalCompare(notional, '0') <= 0 || decimalCompare(maintenanceMarginRate, '0') <= 0) {
      return decimalZero();
    }
    return decimalMultiply(notional, maintenanceMarginRate);
  }

  /**
   * Check if available margin is sufficient for required initial margin.
   */
  public hasSufficientMargin(availableMargin: string, requiredMargin: string): boolean {
    if (decimalCompare(requiredMargin, '0') <= 0) return false;
    return decimalCompare(availableMargin, requiredMargin) >= 0;
  }

  /**
   * Calculate Unrealized PnL:
   * LONG: (markPrice - entryPrice) * quantity
   * SHORT: (entryPrice - markPrice) * quantity
   */
  public calculateUnrealizedPnl(
    side: PositionSide,
    quantity: string,
    entryPrice: string,
    markPrice: string
  ): string {
    if (decimalCompare(quantity, '0') <= 0) return decimalZero();

    if (side === 'LONG') {
      const diff = decimalSubtract(markPrice, entryPrice);
      return decimalMultiply(diff, quantity);
    } else {
      const diff = decimalSubtract(entryPrice, markPrice);
      return decimalMultiply(diff, quantity);
    }
  }

  /**
   * Calculate Realized PnL for closed quantity:
   * LONG: (closePrice - entryPrice) * closeQuantity
   * SHORT: (entryPrice - closePrice) * closeQuantity
   */
  public calculateRealizedPnl(
    side: PositionSide,
    closeQuantity: string,
    entryPrice: string,
    closePrice: string
  ): string {
    if (decimalCompare(closeQuantity, '0') <= 0) return decimalZero();

    if (side === 'LONG') {
      const diff = decimalSubtract(closePrice, entryPrice);
      return decimalMultiply(diff, closeQuantity);
    } else {
      const diff = decimalSubtract(entryPrice, closePrice);
      return decimalMultiply(diff, closeQuantity);
    }
  }

  /**
   * Calculate Position Equity:
   * ISOLATED: Initial Margin + Unrealized PnL
   * CROSS: Available Margin + Initial Margin + Unrealized PnL
   */
  public calculatePositionEquity(
    position: Pick<FuturesPositionEntity, 'marginMode' | 'initialMargin' | 'entryPrice' | 'markPrice' | 'quantity' | 'side'>,
    availableMargin = '0'
  ): string {
    const upnl = this.calculateUnrealizedPnl(
      position.side,
      position.quantity,
      position.entryPrice,
      position.markPrice
    );

    if (position.marginMode === 'ISOLATED') {
      return decimalAdd(position.initialMargin, upnl);
    } else {
      const combinedMargin = decimalAdd(availableMargin, position.initialMargin);
      return decimalAdd(combinedMargin, upnl);
    }
  }

  /**
   * Calculate Margin Ratio = Maintenance Margin / Position Equity
   */
  public calculateMarginRatio(maintenanceMargin: string, positionEquity: string): string {
    if (decimalCompare(positionEquity, '0') <= 0) {
      return decimalNormalize('1'); // 100% risk if equity <= 0
    }
    if (decimalCompare(maintenanceMargin, '0') <= 0) {
      return decimalZero();
    }
    return decimalDivide(maintenanceMargin, positionEquity);
  }

  /**
   * Calculate exact Liquidation Price:
   * ISOLATED LONG: LP = EP + (MM - IM) / QTY
   * ISOLATED SHORT: LP = EP + (IM - MM) / QTY
   * CROSS LONG: LP = (EP * QTY - IM - AM) / (QTY * (1 - MMR))
   * CROSS SHORT: LP = (EP * QTY + IM + AM) / (QTY * (1 + MMR))
   */
  public calculateLiquidationPrice(
    position: Pick<FuturesPositionEntity, 'marginMode' | 'side' | 'entryPrice' | 'quantity' | 'initialMargin' | 'maintenanceMargin'>,
    maintenanceMarginRate: string,
    availableMargin = '0'
  ): string {
    const ep = position.entryPrice;
    const q = position.quantity;
    const im = position.initialMargin;
    const mm = position.maintenanceMargin;
    const am = availableMargin;
    const mmr = maintenanceMarginRate;

    if (decimalCompare(q, '0') <= 0 || decimalCompare(ep, '0') <= 0) {
      return decimalZero();
    }

    if (position.marginMode === 'ISOLATED') {
      if (position.side === 'LONG') {
        const delta = decimalSubtract(mm, im);
        const perUnit = decimalDivide(delta, q);
        const lp = decimalAdd(ep, perUnit);
        return decimalCompare(lp, '0') < 0 ? decimalZero() : lp;
      } else {
        const delta = decimalSubtract(im, mm);
        const perUnit = decimalDivide(delta, q);
        const lp = decimalAdd(ep, perUnit);
        return decimalCompare(lp, '0') < 0 ? decimalZero() : lp;
      }
    } else {
      // CROSS MARGIN
      if (position.side === 'LONG') {
        const notional = decimalMultiply(ep, q);
        const numerator = decimalSubtract(decimalSubtract(notional, im), am);
        const denominatorFactor = decimalSubtract('1', mmr);
        const denominator = decimalMultiply(q, denominatorFactor);
        if (decimalCompare(denominator, '0') <= 0) return decimalZero();
        const lp = decimalDivide(numerator, denominator);
        return decimalCompare(lp, '0') < 0 ? decimalZero() : lp;
      } else {
        const notional = decimalMultiply(ep, q);
        const numerator = decimalAdd(decimalAdd(notional, im), am);
        const denominatorFactor = decimalAdd('1', mmr);
        const denominator = decimalMultiply(q, denominatorFactor);
        if (decimalCompare(denominator, '0') <= 0) return decimalZero();
        const lp = decimalDivide(numerator, denominator);
        return decimalCompare(lp, '0') < 0 ? decimalZero() : lp;
      }
    }
  }

  /**
   * Check if a position is eligible for liquidation: Equity < Maintenance Margin.
   */
  public checkLiquidation(
    position: Pick<FuturesPositionEntity, 'marginMode' | 'side' | 'entryPrice' | 'markPrice' | 'quantity' | 'initialMargin' | 'maintenanceMargin'>,
    availableMargin = '0'
  ): boolean {
    const eq = this.calculatePositionEquity(position, availableMargin);
    return decimalCompare(eq, position.maintenanceMargin) < 0;
  }

  /**
   * Determine UI Risk Status:
   * SAFE: Ratio < 0.6
   * WARNING: Ratio >= 0.6 and < 0.9
   * LIQUIDATION_RISK: Ratio >= 0.9
   */
  public getRiskStatus(marginRatio: string): 'SAFE' | 'WARNING' | 'LIQUIDATION_RISK' {
    if (decimalCompare(marginRatio, '0.9') >= 0) return 'LIQUIDATION_RISK';
    if (decimalCompare(marginRatio, '0.6') >= 0) return 'WARNING';
    return 'SAFE';
  }
}

export const futuresRiskService = new FuturesRiskService();
