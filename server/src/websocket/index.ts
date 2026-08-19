/**
 * WebSocket Gateway Skeleton
 * Public and Private realtime WebSocket stream dispatcher.
 * Implementation to be completed in Phase 4 Step 10.
 */

export interface IWebSocketGateway {
  broadcastPublic(channel: string, payload: unknown): void;
  sendToUser(userId: string, channel: string, payload: unknown): void;
}

export const webSocketGatewayPlaceholder = {
  status: 'PENDING_EXTRACTION_PHASE_4_STEP_10'
};
