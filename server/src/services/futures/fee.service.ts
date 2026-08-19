import { decimalMultiply } from '../ledger/decimal';

export interface FuturesFeeResult {
  feeAmount: string;
  feeRate: string;
  feeType: 'MAKER' | 'TAKER';
  notional: string;
}

export class FuturesFeeService {
  private readonly MAKER_FEE_RATE = '0.0002'; // 0.02%
  private readonly TAKER_FEE_RATE = '0.0005'; // 0.05%

  public getMakerFeeRate(): string {
    return this.MAKER_FEE_RATE;
  }

  public getTakerFeeRate(): string {
    return this.TAKER_FEE_RATE;
  }

  public calculateExecutionFee(executedQuantity: string, executedPrice: string, isMaker: boolean): FuturesFeeResult {
    const notional = decimalMultiply(executedQuantity, executedPrice);
    const feeRate = isMaker ? this.MAKER_FEE_RATE : this.TAKER_FEE_RATE;
    const feeType = isMaker ? 'MAKER' : 'TAKER';
    const feeAmount = decimalMultiply(notional, feeRate);

    return {
      feeAmount,
      feeRate,
      feeType,
      notional,
    };
  }
}

export const futuresFeeService = new FuturesFeeService();
