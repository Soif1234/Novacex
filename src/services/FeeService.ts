import { Decimal } from 'decimal.js';

export class FeeService {
  private static readonly FEE_RATE = new Decimal('0.001'); // 0.1%

  public static calculateFee(amount: string | Decimal): string {
    const amt = new Decimal(amount);
    return amt.mul(this.FEE_RATE).toString();
  }
}
