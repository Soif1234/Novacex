/**
 * Futures Service Skeleton
 * Authoritative Futures order execution, position tracking, margin validation, liquidation, and funding.
 * Implementation to be completed in Phase 4 Step 8.
 */

export interface IFuturesService {
  placeOrder(orderParams: unknown): Promise<{ orderId: string; status: string }>;
  cancelOrder(orderId: string, accountId: string): Promise<void>;
  getPositions(accountId: string): Promise<unknown[]>;
  closePosition(positionId: string, accountId: string, price?: string): Promise<void>;
  updateTpSl(positionId: string, accountId: string, tp?: string, sl?: string): Promise<void>;
}

export const futuresServicePlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_8'
};
