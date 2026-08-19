/**
 * Spot Service Skeleton
 * Authoritative Spot order placement, matching engine, and trade settlement.
 * Implementation to be completed in Phase 4 Step 7.
 */

export interface ISpotService {
  placeOrder(orderParams: unknown): Promise<{ orderId: string; status: string }>;
  cancelOrder(orderId: string, accountId: string): Promise<void>;
  getOpenOrders(accountId: string): Promise<unknown[]>;
  getOrderHistory(accountId: string): Promise<unknown[]>;
}

export const spotServicePlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_7'
};
