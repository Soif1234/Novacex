import { FuturesPositionEntity } from '../../models/futures.model';
import {
  decimalMultiply,
  decimalCompare,
  decimalSubtract,
  decimalNormalize,
} from '../ledger/decimal';

export class FuturesFundingService {
  private fundingRate = '0.0001'; // 0.0100% per funding period

  public getFundingRate(): string {
    return this.fundingRate;
  }

  public setFundingRate(rate: string): void {
    this.fundingRate = decimalNormalize(rate);
  }

  /**
   * Calculate estimated funding payment for an open position:
   * LONG pays if fundingRate > 0, receives if fundingRate < 0.
   * SHORT receives if fundingRate > 0, pays if fundingRate < 0.
   */
  public calculateEstimatedFunding(position: FuturesPositionEntity, markPrice: string): string {
    const notional = decimalMultiply(position.quantity, markPrice);
    const amount = decimalMultiply(notional, this.fundingRate);

    if (position.side === 'LONG') {
      // Long pays positive rate
      return decimalCompare(this.fundingRate, '0') > 0 ? decimalSubtract('0', amount) : amount;
    } else {
      // Short receives positive rate
      return amount;
    }
  }
}

export const futuresFundingService = new FuturesFundingService();
