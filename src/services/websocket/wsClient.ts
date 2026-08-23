/**
 * Authoritative WebSocket Client
 *
 * Connects to server WebSocket gateway (ws://localhost:4000/ws).
 * Features:
 *  - Exponential backoff reconnection
 *  - Automatic channel resubscription on reconnect
 *  - Automatic authentication replay on reconnect
 *  - Subscription deduplication
 *  - Heartbeat watchdog
 *  - Event dispatch to subscribers
 */

import { ClientWsMessage, ServerWsMessage, ChannelCallback, ConnectionStatusCallback } from './types';

export class WebSocketClient {
  private url: string;
  private ws: WebSocket | null = null;
  private authToken: string | null = null;
  private isAuthenticated = false;

  private channelListeners = new Map<string, Set<ChannelCallback>>();
  private statusListeners = new Set<ConnectionStatusCallback>();

  private reconnectAttempts = 0;
  private reconnectTimer: any = null;
  private pingInterval: any = null;
  private lastMessageTime = 0;
  private isExplicitlyClosed = false;

  constructor(url?: string) {
    const isProd = typeof import.meta !== 'undefined' && (import.meta as any).env?.PROD;
    const envWs = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_WS_URL;
    
    if (isProd && !envWs && !url) {
      throw new Error('VITE_WS_URL must be configured in production');
    }
    this.url = url || envWs || 'ws://localhost:4000/ws';
  }

  public setUrl(url: string): void {
    this.url = url;
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      this.reconnect();
    }
  }

  public setAuthToken(token: string | null): void {
    this.authToken = token;
    if (!token) {
      this.isAuthenticated = false;
      // Unsubscribe private channels on logout
      for (const channel of this.channelListeners.keys()) {
        if (channel.startsWith('user:')) {
          this.send({ type: 'unsubscribe', channel });
        }
      }
    } else if (this.isConnected()) {
      this.send({ type: 'auth', token });
    }
  }

  public connect(): void {
    if (typeof WebSocket === 'undefined') {
      // Non-browser / test environment without WebSocket global
      return;
    }

    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.isExplicitlyClosed = false;
    this.notifyStatus('CONNECTING');

    try {
      this.ws = new WebSocket(this.url);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this.lastMessageTime = Date.now();
        this.notifyStatus('CONNECTED');
        this.startHeartbeat();

        // 1. Authenticate if token exists
        if (this.authToken) {
          this.send({ type: 'auth', token: this.authToken });
        }

        // 2. Resubscribe to all active channels
        for (const channel of this.channelListeners.keys()) {
          if (!channel.startsWith('user:') || this.authToken) {
            this.send({ type: 'subscribe', channel });
          }
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.lastMessageTime = Date.now();
        try {
          const text = typeof event.data === 'string' ? event.data : event.data.toString();
          const message: ServerWsMessage = JSON.parse(text);
          this.handleServerMessage(message);
        } catch (e) {
          // Ignore parse errors
        }
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.isAuthenticated = false;
        if (!this.isExplicitlyClosed) {
          this.notifyStatus('RECONNECTING');
          this.scheduleReconnect();
        } else {
          this.notifyStatus('DISCONNECTED');
        }
      };

      this.ws.onerror = () => {
        // Socket error handled in onclose
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private handleServerMessage(msg: ServerWsMessage): void {
    if (!msg || !msg.type) return;

    if (msg.type === 'auth_success') {
      this.isAuthenticated = true;
      // Resubscribe to private channels now that auth is confirmed
      for (const channel of this.channelListeners.keys()) {
        if (channel.startsWith('user:')) {
          this.send({ type: 'subscribe', channel });
        }
      }
      return;
    }

    if (msg.type === 'auth_failed') {
      this.isAuthenticated = false;
      return;
    }

    if (msg.type === 'event' || msg.type === 'snapshot') {
      const listeners = this.channelListeners.get(msg.channel);
      if (listeners && listeners.size > 0) {
        for (const cb of listeners) {
          try {
            cb(msg.data, msg.type);
          } catch (err) {
            console.error(`Error in WebSocket callback for channel ${msg.channel}:`, err);
          }
        }
      }
    }
  }

  public subscribe(channel: string, callback: ChannelCallback): () => void {
    let listeners = this.channelListeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.channelListeners.set(channel, listeners);

      // Send subscribe frame if connected
      if (this.isConnected()) {
        if (!channel.startsWith('user:') || this.isAuthenticated) {
          this.send({ type: 'subscribe', channel });
        }
      }
    }

    listeners.add(callback);

    if (!this.isConnected() && !this.isExplicitlyClosed) {
      this.connect();
    }

    // Return unsubscription function
    return () => {
      this.unsubscribe(channel, callback);
    };
  }

  public unsubscribe(channel: string, callback: ChannelCallback): void {
    const listeners = this.channelListeners.get(channel);
    if (!listeners) return;

    listeners.delete(callback);

    if (listeners.size === 0) {
      this.channelListeners.delete(channel);
      if (this.isConnected()) {
        this.send({ type: 'unsubscribe', channel });
      }
    }
  }

  public onStatusChange(callback: ConnectionStatusCallback): () => void {
    this.statusListeners.add(callback);
    return () => {
      this.statusListeners.delete(callback);
    };
  }

  private notifyStatus(status: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'RECONNECTING'): void {
    for (const cb of this.statusListeners) {
      try {
        cb(status);
      } catch {}
    }
  }

  public send(msg: ClientWsMessage): void {
    if (this.isConnected()) {
      try {
        this.ws!.send(JSON.stringify(msg));
      } catch {}
    }
  }

  public isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private scheduleReconnect(): void {
    if (this.isExplicitlyClosed) return;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    // Exponential backoff: 1s, 2s, 4s, 8s, max 15s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 15000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  public reconnect(): void {
    this.disconnect();
    this.connect();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();

    this.pingInterval = setInterval(() => {
      if (this.isConnected()) {
        this.send({ type: 'ping' });

        // If no message received for 60 seconds, reconnect
        if (Date.now() - this.lastMessageTime > 60000) {
          this.reconnect();
        }
      }
    }, 25000);
  }

  private stopHeartbeat(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  public disconnect(): void {
    this.isExplicitlyClosed = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
  }
}

export const wsClient = new WebSocketClient();
