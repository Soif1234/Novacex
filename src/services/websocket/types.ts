/**
 * WebSocket Protocol Types
 * Matches server WebSocket gateway (server/src/websocket/index.ts).
 */

export type ClientWsMessage =
  | { type: 'ping' }
  | { type: 'auth'; token: string }
  | { type: 'subscribe'; channel: string }
  | { type: 'unsubscribe'; channel: string };

export type ServerWsMessage =
  | { type: 'pong'; timestamp: number }
  | { type: 'auth_success'; data: { userId: string; email: string } }
  | { type: 'auth_failed'; code: string; message: string }
  | { type: 'subscribed'; channel: string }
  | { type: 'unsubscribed'; channel: string }
  | { type: 'snapshot'; channel: string; data: any; timestamp: number }
  | { type: 'event'; channel: string; data: any; timestamp: number }
  | { type: 'error'; code: string; message: string; timestamp: number };

export type ChannelCallback = (data: any, type: 'event' | 'snapshot') => void;
export type ConnectionStatusCallback = (status: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING') => void;
