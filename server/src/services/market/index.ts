/**
 * Market Data Ingestor Skeleton
 * Centralized market ticker and orderbook streaming from external gateways.
 * Implementation to be completed in Phase 4 Step 9.
 */

export interface IMarketDataService {
  getTicker(symbol: string): Promise<unknown>;
  getAllTickers(): Promise<unknown[]>;
  getOrderBook(symbol: string): Promise<unknown>;
}

export const marketDataServicePlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_9'
};
