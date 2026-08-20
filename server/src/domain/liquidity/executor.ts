import { ExecutionPlan, ExecutionResult, ExecutionStatus, OrderSlice } from '../../models/liquidity.model';
import { NormalizedOrderRequest } from './adapter';
import { providerRegistry } from './registry';
import { ProviderError, ProviderErrorCode } from './errors';

export interface InternalExecutionConfig {
  executeInternalSlice: (slice: OrderSlice, orderDetails: any) => Promise<ExecutionResult>;
}

export class ExternalExecutionService {
  constructor(private internalExecutor?: InternalExecutionConfig) {}

  public async executePlan(
    plan: ExecutionPlan, 
    orderDetails: { clientOrderId: string; symbol: string; side: 'BUY'|'SELL'; type: 'MARKET'|'LIMIT'; price?: string; metadata?: any }
  ): Promise<ExecutionResult> {
    
    let totalExecutedQty = 0;
    let totalCostNotional = 0;
    let totalFees = 0;
    
    let hasUnknown = false;
    let hasFailed = false;
    let hasRejection = false;

    for (const slice of plan.slices) {
      let sliceResult: ExecutionResult;

      try {
        if (slice.source.sourceType === 'INTERNAL') {
           sliceResult = await this.executeInternal(slice, orderDetails);
        } else {
           sliceResult = await this.executeExternal(slice, orderDetails);
        }
      } catch (error: any) {
        sliceResult = this.normalizeErrorToResult(error);
      }

      const qty = Number(sliceResult.executedQuantity);
      if (!isNaN(qty) && qty > 0) {
          totalExecutedQty += qty;
          const avgPrice = Number(sliceResult.averagePrice);
          if (!isNaN(avgPrice)) {
              totalCostNotional += qty * avgPrice;
          }
      }
      
      const fee = Number(sliceResult.fees);
      if (!isNaN(fee) && fee > 0) {
          totalFees += fee;
      }

      if (sliceResult.status === 'UNKNOWN') hasUnknown = true;
      if (sliceResult.status === 'FAILED') hasFailed = true;
      if (sliceResult.status === 'REJECTED') hasRejection = true;
      
      // Stop execution if UNKNOWN is encountered to prevent double spend or unhedged risk
      if (sliceResult.status === 'UNKNOWN') {
         break;
      }
    }

    const requestedQuantity = Number(plan.estimatedQuantity);
    
    // Safety check: overfill
    if (totalExecutedQty > requestedQuantity) {
       totalExecutedQty = requestedQuantity; // Cap logically for the unified result
    }

    let finalStatus: ExecutionStatus = 'FILLED';
    if (hasUnknown) {
      finalStatus = 'UNKNOWN';
    } else if (totalExecutedQty === 0) {
      if (hasRejection) finalStatus = 'REJECTED';
      else if (hasFailed) finalStatus = 'FAILED';
      else finalStatus = 'REJECTED';
    } else if (totalExecutedQty > 0 && totalExecutedQty < requestedQuantity) {
      finalStatus = 'PARTIALLY_FILLED';
    }

    const avgPrice = totalExecutedQty > 0 ? (totalCostNotional / totalExecutedQty) : 0;

    return {
      status: finalStatus,
      executedQuantity: totalExecutedQty.toFixed(8),
      averagePrice: avgPrice.toFixed(8),
      fees: totalFees.toFixed(8),
      slippage: '0', 
      providerReference: plan.planId,
      reconciliationRequired: hasUnknown
    };
  }

  private async executeExternal(slice: OrderSlice, orderDetails: any): Promise<ExecutionResult> {
     const sliceClientId = `${orderDetails.clientOrderId}-${slice.sliceId}`;
     const providerId = slice.source.venueId;

     const adapter = providerRegistry.getAdapter(providerId);
     if (!adapter) {
        return { status: 'FAILED', executedQuantity: '0', averagePrice: '0', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: false };
     }

     const req: NormalizedOrderRequest = {
        clientOrderId: sliceClientId,
        symbol: orderDetails.symbol,
        side: orderDetails.side,
        type: orderDetails.type,
        quantity: slice.quantity,
        price: orderDetails.price,
        metadata: orderDetails.metadata // Pass through test triggers
     };

     const res = await adapter.placeOrder(req);

     let executedQty = Number(res.executedQuantity);
     let avgPrice = Number(res.averagePrice);
     let fee = Number(res.fee);

     // Safety bounds: invalid returns from provider
     if (isNaN(executedQty) || executedQty < 0) executedQty = 0;
     if (isNaN(avgPrice) || avgPrice <= 0) executedQty = 0; // Invalid price invalidates the fill logically here
     if (isNaN(fee) || fee < 0) fee = 0;

     // Enforce overfill protection: cannot execute more than slice quantity
     if (executedQty > Number(slice.quantity)) {
        executedQty = Number(slice.quantity);
     }

     let reconciliationRequired = false;
     let resultStatus = res.status;
     if (resultStatus === 'UNKNOWN') {
        reconciliationRequired = true;
     }
     
     // Normalize FAILED vs REJECTED cleanly if executedQty is zero
     if (executedQty === 0 && resultStatus === 'FILLED') {
        resultStatus = 'REJECTED';
     }

     return {
        status: resultStatus,
        executedQuantity: executedQty.toFixed(8),
        averagePrice: executedQty > 0 ? avgPrice.toFixed(8) : '0',
        fees: fee.toFixed(8),
        slippage: '0',
        providerReference: res.providerOrderId || '',
        reconciliationRequired
     };
  }

  private async executeInternal(slice: OrderSlice, orderDetails: any): Promise<ExecutionResult> {
    if (this.internalExecutor) {
       return await this.internalExecutor.executeInternalSlice(slice, orderDetails);
    }
    
    // Safe default mock for internal simulation if not wired to OrderCoreService
    const qty = Number(slice.quantity);
    if (orderDetails.metadata?.simulateInternalFailure) {
       return {
          status: 'FAILED', executedQuantity: '0', averagePrice: '0', fees: '0', slippage: '0', providerReference: `INTERNAL-${slice.sliceId}`, reconciliationRequired: false
       };
    }

    return {
       status: 'FILLED',
       executedQuantity: qty.toFixed(8),
       averagePrice: Number(slice.expectedPrice).toFixed(8),
       fees: Number(slice.estimatedFee).toFixed(8),
       slippage: '0',
       providerReference: `INTERNAL-${slice.sliceId}`,
       reconciliationRequired: false
    };
  }

  private normalizeErrorToResult(error: any): ExecutionResult {
     if (error instanceof ProviderError) {
        if (error.code === ProviderErrorCode.NETWORK_FAILURE || error.code === ProviderErrorCode.TIMEOUT || error.code === ProviderErrorCode.UNKNOWN_EXECUTION_STATE) {
           return { status: 'UNKNOWN', executedQuantity: '0', averagePrice: '0', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: true };
        }
        return { status: 'REJECTED', executedQuantity: '0', averagePrice: '0', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: false };
     }
     return { status: 'FAILED', executedQuantity: '0', averagePrice: '0', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: false };
  }
}
