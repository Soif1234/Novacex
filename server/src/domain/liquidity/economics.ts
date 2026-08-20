import { ProviderError, ProviderErrorCode } from './errors';
import { ExecutionPlan, ExecutionResult, OrderSlice } from '../../models/liquidity.model';

export type FeeCategory = 'PROVIDER_FEE' | 'NOVACEX_FEE' | 'NETWORK_FEE' | 'GAS_FEE' | 'OTHER_EXECUTION_COST';

export interface ExecutionFee {
  category: FeeCategory;
  amount: string;
  asset: string;
  sourceId: string;
}

export interface ExecutionEconomics {
  requestedQuantity: string;
  executedQuantity: string;
  requestedPrice: string;
  referencePrice: string;
  averageExecutionPrice: string;

  providerFees: ExecutionFee[];
  novaCEXFees: ExecutionFee[];
  networkCosts: ExecutionFee[];

  totalExternalCostsByAsset: Record<string, string>;
  totalNovaCEXCostsByAsset: Record<string, string>;

  estimatedSlippage: string;
  actualSlippage: string;

  effectiveExecutionPrice: string;
  effectiveExecutionCost: string;
  effectiveExecutionProceeds: string;
}

export interface SliceResult {
  slice: OrderSlice;
  result: ExecutionResult;
  providerFeeAsset?: string;
  novaCEXFeeAsset?: string;
  novaCEXFeeAmount?: string;
}

export interface EconomicsParams {
  side: 'BUY' | 'SELL';
  requestedQuantity: string;
  requestedPrice?: string;
  referencePrice: string;
  quoteAsset: string;
  feeExchangeRates: Record<string, string>;
}

export class EconomicsCalculator {
  
  public static calculateEconomics(
    plan: ExecutionPlan,
    sliceResults: SliceResult[],
    params: EconomicsParams
  ): ExecutionEconomics {

    if (!params.referencePrice || Number(params.referencePrice) <= 0 || isNaN(Number(params.referencePrice))) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Missing or invalid reference price', 'ECONOMICS');
    }

    if (Number(params.requestedQuantity) < 0 || isNaN(Number(params.requestedQuantity))) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid requested quantity', 'ECONOMICS');
    }

    let totalExecutedQuantity = 0;
    let totalNotional = 0;

    const providerFees: ExecutionFee[] = [];
    const novaCEXFees: ExecutionFee[] = [];
    const networkCosts: ExecutionFee[] = [];
    const totalExternalCostsByAsset: Record<string, string> = {};
    const totalNovaCEXCostsByAsset: Record<string, string> = {};

    for (const sr of sliceResults) {
      const execQty = Number(sr.result.executedQuantity);
      if (isNaN(execQty) || execQty < 0 || !isFinite(execQty)) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Negative or invalid executed quantity', 'ECONOMICS');
      }

      if (execQty > 0) {
        const avgPrice = Number(sr.result.averagePrice);
        if (isNaN(avgPrice) || avgPrice < 0 || !isFinite(avgPrice)) {
           throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Negative or invalid execution price', 'ECONOMICS');
        }
        totalExecutedQuantity += execQty;
        totalNotional += (execQty * avgPrice);
      }

      // Process Provider Fee
      const pFee = Number(sr.result.fees);
      if (isNaN(pFee) || pFee < 0 || !isFinite(pFee)) {
        throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid negative fee', 'ECONOMICS');
      }
      
      if (pFee > 0) {
         const pAsset = sr.providerFeeAsset || params.quoteAsset;
         const cat = sr.slice.source.sourceType === 'EXTERNAL' ? 'PROVIDER_FEE' : 'NETWORK_FEE';
         
         const feeRecord = {
           category: cat,
           amount: pFee.toFixed(8),
           asset: pAsset,
           sourceId: sr.slice.source.venueId
         };
         
         if (cat === 'PROVIDER_FEE') {
            providerFees.push(feeRecord as ExecutionFee);
            totalExternalCostsByAsset[pAsset] = ((Number(totalExternalCostsByAsset[pAsset]) || 0) + pFee).toFixed(8);
         } else {
            networkCosts.push(feeRecord as ExecutionFee);
         }
      }

      // Process NovaCEX Fee
      const nFee = Number(sr.novaCEXFeeAmount || 0);
      if (isNaN(nFee) || nFee < 0 || !isFinite(nFee)) {
         throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Invalid negative NovaCEX fee', 'ECONOMICS');
      }
      if (nFee > 0) {
         const nAsset = sr.novaCEXFeeAsset || params.quoteAsset;
         novaCEXFees.push({
           category: 'NOVACEX_FEE',
           amount: nFee.toFixed(8),
           asset: nAsset,
           sourceId: 'NOVACEX'
         });
         totalNovaCEXCostsByAsset[nAsset] = ((Number(totalNovaCEXCostsByAsset[nAsset]) || 0) + nFee).toFixed(8);
      }
    }

    const averageExecutionPrice = totalExecutedQuantity > 0 ? (totalNotional / totalExecutedQuantity) : 0;
    const refPrice = Number(params.referencePrice);

    // Slippage Calculation (Actual)
    let actualSlippage = 0;
    if (totalExecutedQuantity > 0) {
      if (params.side === 'BUY') {
        actualSlippage = averageExecutionPrice - refPrice;
      } else {
        actualSlippage = refPrice - averageExecutionPrice;
      }
    }

    // Slippage Calculation (Estimated)
    let estimatedSlippage = 0;
    const estAvgPrice = Number(plan.estimatedAveragePrice);
    if (!isNaN(estAvgPrice) && estAvgPrice > 0) {
      if (params.side === 'BUY') {
        estimatedSlippage = estAvgPrice - refPrice;
      } else {
        estimatedSlippage = refPrice - estAvgPrice;
      }
    }

    // Convert all fees to quote asset for effective calculations
    let totalFeesInQuote = 0;
    const allFees = [...providerFees, ...novaCEXFees, ...networkCosts];
    
    for (const f of allFees) {
       const rate = Number(params.feeExchangeRates[f.asset]);
       if (isNaN(rate) || rate <= 0 || !isFinite(rate)) {
          throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Missing or invalid exchange rate for fee asset: ${f.asset}`, 'ECONOMICS');
       }
       totalFeesInQuote += (Number(f.amount) * rate);
    }

    let effectiveExecutionCost = 0;
    let effectiveExecutionProceeds = 0;
    let effectiveExecutionPrice = 0;

    if (params.side === 'BUY') {
       effectiveExecutionCost = totalNotional + totalFeesInQuote;
       effectiveExecutionPrice = totalExecutedQuantity > 0 ? (effectiveExecutionCost / totalExecutedQuantity) : 0;
    } else {
       effectiveExecutionProceeds = totalNotional - totalFeesInQuote;
       effectiveExecutionPrice = totalExecutedQuantity > 0 ? (effectiveExecutionProceeds / totalExecutedQuantity) : 0;
    }

    return {
      requestedQuantity: Number(params.requestedQuantity).toFixed(8),
      executedQuantity: totalExecutedQuantity.toFixed(8),
      requestedPrice: params.requestedPrice || '0.00000000',
      referencePrice: params.referencePrice,
      averageExecutionPrice: averageExecutionPrice.toFixed(8),
      providerFees,
      novaCEXFees,
      networkCosts,
      totalExternalCostsByAsset,
      totalNovaCEXCostsByAsset,
      estimatedSlippage: estimatedSlippage.toFixed(8),
      actualSlippage: actualSlippage.toFixed(8),
      effectiveExecutionPrice: effectiveExecutionPrice.toFixed(8),
      effectiveExecutionCost: effectiveExecutionCost.toFixed(8),
      effectiveExecutionProceeds: effectiveExecutionProceeds.toFixed(8)
    };
  }
}
