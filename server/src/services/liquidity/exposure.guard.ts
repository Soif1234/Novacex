import { IExposureGuard, ExposureDecision, ExposureGuardInputs, RiskLimits } from '../../domain/liquidity/exposure-guard.interface';
import { decimalCompare, decimalAdd, decimalSubtract, decimalIsPositive, decimalIsNonNegative } from '../ledger/decimal';

export class ExposureGuard implements IExposureGuard {

  public evaluateHedge(inputs: ExposureGuardInputs, limits: RiskLimits): ExposureDecision {
    if (inputs.hyperliquidHedgeHalt) {
      return { result: 'HALT', reason: 'Circuit Breaker: Hedge Halt is active' };
    }

    if (inputs.marketDataFreshness === 'STALE' || inputs.marketDataFreshness === 'DISCONNECTED') {
      return { result: 'HALT', reason: `Market data is ${inputs.marketDataFreshness}. Safe hedging not possible.` };
    }

    // REDUCE_ONLY mode: only allow orders that reduce the net exposure
    if (inputs.hyperliquidReduceOnly) {
      const isRiskIncreasing = this.checkIfRiskIncreasing(
        inputs.currentHouseExposure,
        inputs.proposedHedgeSide,
        inputs.pendingHedgeQuantity
      );
      if (isRiskIncreasing) {
        return { result: 'REDUCE_ONLY', reason: 'Circuit Breaker: Reduce Only is active. Cannot increase risk.' };
      }
    }

    // Size limit check
    if (decimalCompare(inputs.pendingHedgeQuantity, limits.maxHedgeSize) > 0) {
      return {
        result: 'REDUCE_SIZE',
        reason: `Requested size ${inputs.pendingHedgeQuantity} exceeds max order size ${limits.maxHedgeSize}`,
        allowedQuantity: limits.maxHedgeSize
      };
    }

    // Max exposure check (simplified)
    const projectedExposure = inputs.proposedHedgeSide === 'BUY'
      ? decimalAdd(inputs.currentHouseExposure, inputs.pendingHedgeQuantity)
      : decimalSubtract(inputs.currentHouseExposure, inputs.pendingHedgeQuantity);

    // Absolute value of projected exposure
    const absProjected = projectedExposure.startsWith('-') ? projectedExposure.substring(1) : projectedExposure;

    if (decimalCompare(absProjected, limits.maxHouseExposure) > 0) {
      return { result: 'REJECT', reason: `Projected exposure ${absProjected} exceeds max exposure ${limits.maxHouseExposure}` };
    }

    return { result: 'ALLOW', reason: 'All risk limits passed' };
  }

  private checkIfRiskIncreasing(currentExposure: string, proposedSide: 'BUY' | 'SELL', qty: string): boolean {
    const isLong = !currentExposure.startsWith('-') && decimalCompare(currentExposure, '0') > 0;
    const isShort = currentExposure.startsWith('-') && decimalCompare(currentExposure, '0') !== 0;

    if (isLong && proposedSide === 'BUY') return true;
    if (isShort && proposedSide === 'SELL') return true;

    // If exact reduce-only size is needed, we would also check if qty > abs(currentExposure)
    const absCurrent = currentExposure.startsWith('-') ? currentExposure.substring(1) : currentExposure;
    if (decimalCompare(qty, absCurrent) > 0) {
       // flips exposure direction, increasing risk in the other direction
       return true;
    }

    return false;
  }
}
