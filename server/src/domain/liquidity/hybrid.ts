import { NormalizedOrderRequest, NormalizedExecutionResponse } from './adapter';
import { ExecutionStatus } from '../../models/liquidity.model';
import { ProviderError, ProviderErrorCode } from './errors';

// Structural interfaces representing the boundaries of Phase 5 orchestration
export interface IRouter {
    route(order: NormalizedOrderRequest): Promise<{ routeType: string, slices: { provider: string, quantity: string }[] }>;
}

export interface IExecutor {
    execute(order: NormalizedOrderRequest, providerId: string): Promise<NormalizedExecutionResponse>;
}

export interface IExposureGuard {
    checkAndReserve(quantity: string): Promise<boolean>;
    release(quantity: string): void;
}

export interface IReconciliationEngine {
    registerUnknown(response: NormalizedExecutionResponse): Promise<void>;
}

export interface IRetryEngine {
    executeWithRetry<T>(operation: () => Promise<T>): Promise<T>;
}

export interface IEconomicsCalculator {
    aggregate(responses: NormalizedExecutionResponse[]): any;
}

export interface IHedgeManager {
    routeHedge(order: NormalizedOrderRequest): Promise<NormalizedExecutionResponse[]>;
}

export class HybridExecutionEngine {
    constructor(
        private router: IRouter,
        private executor: IExecutor,
        private exposure: IExposureGuard,
        private reconciliation: IReconciliationEngine,
        private retry: IRetryEngine,
        private economics: IEconomicsCalculator,
        private hedge: IHedgeManager
    ) {}
    
    /**
     * Phase 5.15 Orchestration Boundary
     * Unifies Smart Routing, Exposure, Retry, Hedge, and Execution into a single safe flow.
     */
    async execute(order: NormalizedOrderRequest): Promise<{ status: ExecutionStatus, responses: NormalizedExecutionResponse[], economics: any }> {
        
        // 1. FUTURES ISOLATION: Futures orders STRICTLY route to Hedge Manager
        if (order.metadata?.isFutures) {
            const hedgeResponses = await this.hedge.routeHedge(order);
            const hedgeEcon = this.economics.aggregate(hedgeResponses);
            
            let hedgeStatus: ExecutionStatus = 'UNKNOWN';
            if (hedgeResponses.every(r => r.status === 'FILLED')) hedgeStatus = 'FILLED';
            else if (hedgeResponses.some(r => r.status === 'FILLED' || r.status === 'PARTIALLY_FILLED')) hedgeStatus = 'PARTIALLY_FILLED';
            else if (hedgeResponses.every(r => r.status === 'REJECTED')) hedgeStatus = 'REJECTED';
            else if (hedgeResponses.some(r => r.status === 'UNKNOWN')) hedgeStatus = 'UNKNOWN';

            return { status: hedgeStatus, responses: hedgeResponses, economics: hedgeEcon };
        }

        // 2. SPOT HYBRID ROUTING
        const plan = await this.router.route(order);
        const responses: NormalizedExecutionResponse[] = [];
        let overallStatus: ExecutionStatus = 'ACKNOWLEDGED';

        // 3. INTERNAL EXECUTION
        const internalSlice = plan.slices.find(s => s.provider === 'INTERNAL');
        if (internalSlice) {
            // Internal matching engine is fully deterministic and authoritative
            responses.push({
                providerOrderId: 'INT-' + order.clientOrderId,
                clientOrderId: order.clientOrderId,
                status: 'FILLED', // Simplified for Phase 5.15 mapping boundary
                executedQuantity: internalSlice.quantity,
                remainingQuantity: '0',
                averagePrice: order.price || '0',
                fee: '0',
                feeAsset: 'USDC',
                providerReference: 'INTERNAL',
                timestamps: { created: new Date(), updated: new Date() }
            });
        }

        // 4. EXTERNAL EXECUTION
        const externalSlice = plan.slices.find(s => s.provider !== 'INTERNAL');
        if (externalSlice) {
            // A. Exposure Validation
            const exposureOk = await this.exposure.checkAndReserve(externalSlice.quantity);
            if (!exposureOk) {
                throw new ProviderError(ProviderErrorCode.AUTHORIZATION_FAILURE, 'Exposure reservation failed. Zero external execution permitted.', 'HYBRID');
            }

            const extReq: NormalizedOrderRequest = {
                ...order,
                quantity: externalSlice.quantity,
                clientOrderId: order.clientOrderId // Strict Idempotency preservation
            };

            try {
                // B. Retry Engine wrapped execution
                const extRes = await this.retry.executeWithRetry(() => this.executor.execute(extReq, externalSlice.provider));
                
                // C. UNKNOWN / Reconciliation interception
                if (extRes.status === 'UNKNOWN') {
                    // Do NOT release exposure for UNKNOWN
                    await this.reconciliation.registerUnknown(extRes);
                } 
                // D. Exposure Release on Terminal Failure
                else if (extRes.status === 'REJECTED' || extRes.status === 'CANCELLED' || extRes.status === 'FAILED') {
                    this.exposure.release(externalSlice.quantity);
                } 
                // E. Partial Exposure Release
                else if (extRes.status === 'PARTIALLY_FILLED' || extRes.status === 'ACKNOWLEDGED') {
                    const released = Number(externalSlice.quantity) - Number(extRes.executedQuantity);
                    if (released > 0) {
                        this.exposure.release(released.toString());
                    }
                }
                
                responses.push(extRes);
            } catch (err: any) {
                // F. Complete timeout before submission exhausts retry budget
                if (err.message && err.message.includes('Exposure limit')) {
                    throw err; // Bubble validation up
                }
                
                // On true catastrophic crash before UNKNOWN status could be yielded, release exposure safely
                this.exposure.release(externalSlice.quantity);
                throw err;
            }
        }

        // 5. AGGREGATE STATUS
        if (responses.some(r => r.status === 'UNKNOWN')) {
            overallStatus = 'UNKNOWN';
        } else if (responses.every(r => r.status === 'FILLED')) {
            overallStatus = 'FILLED';
        } else if (responses.some(r => r.status === 'FILLED' || r.status === 'PARTIALLY_FILLED')) {
            overallStatus = 'PARTIALLY_FILLED';
        } else if (responses.every(r => r.status === 'REJECTED' || r.status === 'FAILED')) {
            overallStatus = 'REJECTED';
        }

        // 6. AGGREGATE ECONOMICS
        const aggregated = this.economics.aggregate(responses);
        return { status: overallStatus, responses, economics: aggregated };
    }
}
