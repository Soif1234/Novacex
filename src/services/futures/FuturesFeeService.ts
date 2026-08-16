import { Decimal } from 'decimal.js';
import { FuturesOrderType } from '../../types/futures';

export interface FeeCalculationResult {
    feeAmount: string;
    feeRate: string;
    feeType: 'MAKER' | 'TAKER';
    notional: string;
}

export class FuturesFeeService {
    // Configured demo fees
    private readonly MAKER_FEE_RATE = '0.0002'; // 0.02%
    private readonly TAKER_FEE_RATE = '0.0005'; // 0.05%

    public getMakerFeeRate(): string {
        return this.MAKER_FEE_RATE;
    }

    public getTakerFeeRate(): string {
        return this.TAKER_FEE_RATE;
    }

    public getEstimatedFee(quantity: string, price: string, orderType: FuturesOrderType): FeeCalculationResult {
        const notional = new Decimal(quantity).mul(new Decimal(price));
        // Simple logic for estimating: Market is taker, others are maker
        const feeRate = orderType === 'MARKET' ? this.TAKER_FEE_RATE : this.MAKER_FEE_RATE;
        const feeType = orderType === 'MARKET' ? 'TAKER' : 'MAKER';
        
        const feeAmount = notional.mul(new Decimal(feeRate)).toString();

        return {
            feeAmount,
            feeRate,
            feeType,
            notional: notional.toString()
        };
    }

    public calculateExecutionFee(executedQuantity: string, executedPrice: string, isMaker: boolean): FeeCalculationResult {
        const notional = new Decimal(executedQuantity).mul(new Decimal(executedPrice));
        const feeRate = isMaker ? this.MAKER_FEE_RATE : this.TAKER_FEE_RATE;
        const feeType = isMaker ? 'MAKER' : 'TAKER';
        
        const feeAmount = notional.mul(new Decimal(feeRate)).toString();

        return {
            feeAmount,
            feeRate,
            feeType,
            notional: notional.toString()
        };
    }
}

export const futuresFeeService = new FuturesFeeService();
