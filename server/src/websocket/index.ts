import { Server as HttpServer, IncomingMessage } from 'http';
import { env } from '../config/env';
import { Duplex } from 'stream';
import crypto from 'crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { EventBus, eventBus } from '../services/market/event-bus';
import { MarketDataService, marketDataService } from '../services/market/market.service';
import { SessionService, sessionService } from '../services/auth/session.service';
import { ClientWsMessage, ServerWsMessage, MarketEvent } from '../services/market/types';
import { logger } from '../config/logger';

export interface WebSocketGatewayOptions {
  server?: HttpServer;
  path?: string;
  heartbeatIntervalMs?: number;
  maxSubscriptionsPerClient?: number;
  maxMessageRatePerMinute?: number;
  maxPayloadBytes?: number;
  eventBus?: EventBus;
  marketService?: MarketDataService;
  sessionService?: SessionService;
}

export interface ClientConnection {
  id: string;
  socket: WebSocket;
  ip: string;
  userId?: string;
  userEmail?: string;
  authenticated: boolean;
  subscriptions: Set<string>;
  lastHeartbeat: number;
  messageTimestamps: number[];
  connectedAt: Date;
}

export class WebSocketGateway {
  private wss: WebSocketServer | null = null;
  private clients = new Map<string, ClientConnection>(); // connectionId -> ClientConnection
  private userConnections = new Map<string, Set<string>>(); // userId -> Set<connectionId>
  private channelSubscribers = new Map<string, Set<string>>(); // channel -> Set<connectionId>

  private bus: EventBus;
  private market: MarketDataService;
  private sessions: SessionService;

  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly heartbeatIntervalMs: number;
  private readonly maxSubscriptions: number;
  private readonly maxMessageRate: number;
  private readonly maxPayloadBytes: number;
  private busUnsubscribers: Array<() => void> = [];

  constructor(options: WebSocketGatewayOptions = {}) {
    this.bus = options.eventBus || eventBus;
    this.market = options.marketService || marketDataService;
    this.sessions = options.sessionService || sessionService;

    this.heartbeatIntervalMs = options.heartbeatIntervalMs || 30000;
    this.maxSubscriptions = options.maxSubscriptionsPerClient || 50;
    this.maxMessageRate = options.maxMessageRatePerMinute || 300;
    this.maxPayloadBytes = options.maxPayloadBytes || 65536; // 64 KB

    if (options.server) {
      this.attachToServer(options.server, options.path || '/ws');
    }

    this.initEventBusBridge();
  }

  /**
   * Attach WebSocket server to an existing Node.js HTTP server.
   */
  public attachToServer(server: HttpServer, path = '/ws'): void {
    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(request.url || '', `http://${request.headers.host || 'localhost'}`);
      if (url.pathname === path || url.pathname.startsWith(`${path}/`)) {
        const origin = request.headers.origin;
        if (env.NODE_ENV === 'production' && origin) {
          const allowedOrigins = env.CORS_ORIGIN.split(',').map(o => o.trim());
          if (!allowedOrigins.includes(origin) && !allowedOrigins.includes('*')) {
            socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
            socket.destroy();
            return;
          }
        }
        this.wss!.handleUpgrade(request, socket, head, (ws: WebSocket) => {
          this.wss!.emit('connection', ws, request);
        });
      }
    });

    this.wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
      this.handleNewConnection(socket, request);
    });

    this.startHeartbeat();
    logger.info(`WebSocket Gateway attached to HTTP server at ${path}`);
  }

  /**
   * Handle new incoming WebSocket connection.
   */
  public handleNewConnection(socket: WebSocket, request?: IncomingMessage): ClientConnection {
    const connectionId = crypto.randomUUID();
    const ip = request?.socket?.remoteAddress || '127.0.0.1';

    const client: ClientConnection = {
      id: connectionId,
      socket,
      ip,
      authenticated: false,
      subscriptions: new Set(),
      lastHeartbeat: Date.now(),
      messageTimestamps: [],
      connectedAt: new Date(),
    };

    this.clients.set(connectionId, client);

    socket.on('message', (data: any, isBinary: boolean) => {
      this.handleClientMessage(client, data, isBinary);
    });

    socket.on('close', () => {
      this.handleClientDisconnect(client);
    });

    socket.on('error', (err: Error) => {
      logger.warn('WebSocket client socket error', { connectionId, error: err.message });
      this.handleClientDisconnect(client);
    });

    socket.on('pong', () => {
      client.lastHeartbeat = Date.now();
    });

    return client;
  }

  /**
   * Process raw client message.
   */
  private async handleClientMessage(client: ClientConnection, raw: any, isBinary: boolean): Promise<void> {
    try {
      client.lastHeartbeat = Date.now();

      if (isBinary) {
        this.sendError(client, 'BINARY_NOT_SUPPORTED', 'Binary WebSocket frames are not supported');
        return;
      }

      const text = typeof raw === 'string' ? raw : raw.toString('utf-8');
      if (text.length > this.maxPayloadBytes) {
        this.sendError(client, 'PAYLOAD_TOO_LARGE', `Message exceeds maximum allowed payload of ${this.maxPayloadBytes} bytes`);
        return;
      }

      // Rate limit check
      const now = Date.now();
      client.messageTimestamps = client.messageTimestamps.filter(t => now - t < 60000);
      if (client.messageTimestamps.length >= this.maxMessageRate) {
        this.sendError(client, 'RATE_LIMIT_EXCEEDED', 'Message rate limit exceeded. Please slow down.');
        return;
      }
      client.messageTimestamps.push(now);

      let message: ClientWsMessage;
      try {
        message = JSON.parse(text);
      } catch (e) {
        this.sendError(client, 'INVALID_JSON', 'Malformed JSON message');
        return;
      }

      if (!message || typeof message !== 'object' || !message.type) {
        this.sendError(client, 'INVALID_PROTOCOL', 'Message must include a valid "type" field');
        return;
      }

      switch (message.type) {
        case 'ping':
          this.sendMessage(client, { type: 'pong', timestamp: Date.now() });
          break;

        case 'auth':
          await this.handleAuthentication(client, message.token);
          break;

        case 'subscribe':
          if (!message.channel || typeof message.channel !== 'string') {
            this.sendError(client, 'INVALID_CHANNEL', 'Subscription requires a valid "channel" string');
            return;
          }
          await this.handleSubscribe(client, message.channel.trim());
          break;

        case 'unsubscribe':
          if (!message.channel || typeof message.channel !== 'string') {
            this.sendError(client, 'INVALID_CHANNEL', 'Unsubscribe requires a valid "channel" string');
            return;
          }
          this.handleUnsubscribe(client, message.channel.trim());
          break;

        default:
          this.sendError(client, 'UNKNOWN_MESSAGE_TYPE', `Unsupported message type "${(message as any).type}"`);
          break;
      }
    } catch (err: any) {
      logger.error('Unexpected error processing WebSocket message', { error: err.message, connectionId: client.id });
      this.sendError(client, 'INTERNAL_ERROR', 'Internal server error processing message');
    }
  }

  /**
   * Handle user authentication message.
   */
  private async handleAuthentication(client: ClientConnection, token?: string): Promise<void> {
    if (!token || typeof token !== 'string' || !token.trim()) {
      this.sendMessage(client, {
        type: 'auth_failed',
        code: 'MISSING_TOKEN',
        message: 'Authentication token is required',
      });
      return;
    }

    try {
      const user = await this.sessions.authenticateSession(token.trim());
      if (!user) {
        this.sendMessage(client, {
          type: 'auth_failed',
          code: 'INVALID_SESSION',
          message: 'Invalid or expired session token',
        });
        return;
      }

      client.authenticated = true;
      client.userId = user.id;
      client.userEmail = user.email;

      if (!this.userConnections.has(user.id)) {
        this.userConnections.set(user.id, new Set());
      }
      this.userConnections.get(user.id)!.add(client.id);

      this.sendMessage(client, {
        type: 'auth_success',
        data: {
          userId: user.id,
          email: user.email,
        },
      });

      logger.info('WebSocket client authenticated successfully', { connectionId: client.id, userId: user.id });
    } catch (err: any) {
      this.sendMessage(client, {
        type: 'auth_failed',
        code: err.errorCode || err.code || 'INVALID_SESSION',
        message: err.message || 'Authentication error',
      });
    }

  }

  /**
   * Handle channel subscription.
   */
  private async handleSubscribe(client: ClientConnection, channel: string): Promise<void> {
    if (client.subscriptions.has(channel)) {
      // Idempotent resubscription
      this.sendMessage(client, { type: 'subscribed', channel });
      return;
    }

    if (client.subscriptions.size >= this.maxSubscriptions) {
      this.sendError(client, 'MAX_SUBSCRIPTIONS_REACHED', `Cannot subscribe to more than ${this.maxSubscriptions} channels`);
      return;
    }

    // 1. Validate Private Channels
    if (channel.startsWith('user:')) {
      if (!client.authenticated || !client.userId) {
        this.sendError(client, 'UNAUTHORIZED', `Authentication required to subscribe to private channel "${channel}"`);
        return;
      }

      const validPrivateChannels = ['user:orders', 'user:trades', 'user:balances', 'user:positions'];
      if (!validPrivateChannels.includes(channel)) {
        this.sendError(client, 'INVALID_PRIVATE_CHANNEL', `Unknown private channel "${channel}"`);
        return;
      }

      client.subscriptions.add(channel);
      this.registerChannelSubscriber(channel, client.id);
      this.sendMessage(client, { type: 'subscribed', channel });
      return;
    }

    // 2. Validate Public Channels
    const parts = channel.split(':');
    if (parts.length !== 2) {
      this.sendError(client, 'INVALID_CHANNEL_FORMAT', `Invalid channel format "${channel}". Expected "prefix:symbol"`);
      return;
    }

    const [prefix, rawSymbol] = parts;
    const symbol = rawSymbol.toUpperCase();
    const cleanChannel = `${prefix}:${symbol}`;

    const validPrefixes = ['ticker', 'orderbook', 'trades', 'markPrice'];
    if (!validPrefixes.includes(prefix)) {
      this.sendError(client, 'UNKNOWN_CHANNEL_PREFIX', `Unsupported channel prefix "${prefix}"`);
      return;
    }

    client.subscriptions.add(cleanChannel);
    this.registerChannelSubscriber(cleanChannel, client.id);
    this.sendMessage(client, { type: 'subscribed', channel: cleanChannel });

    // 3. For orderbook channel, immediately dispatch initial snapshot
    if (prefix === 'orderbook') {
      const snapshot = this.market.getOrderBook(symbol);
      this.sendMessage(client, {
        type: 'snapshot',
        channel: cleanChannel,
        data: snapshot,
        timestamp: Date.now(),
      });
    }

    // 4. For ticker channel, immediately dispatch current ticker state if available
    if (prefix === 'ticker') {
      const ticker = this.market.getTicker(symbol);
      if (ticker) {
        this.sendMessage(client, {
          type: 'event',
          channel: cleanChannel,
          data: ticker,
          timestamp: Date.now(),
        });
      }
    }

    // 5. For markPrice channel, immediately dispatch current mark price
    if (prefix === 'markPrice') {
      const mark = await this.market.getMarkPrice(symbol);
      this.sendMessage(client, {
        type: 'event',
        channel: cleanChannel,
        data: mark,
        timestamp: Date.now(),
      });
    }
  }

  /**
   * Handle unsubscription.
   */
  private handleUnsubscribe(client: ClientConnection, channel: string): void {
    client.subscriptions.delete(channel);
    const subscribers = this.channelSubscribers.get(channel);
    if (subscribers) {
      subscribers.delete(client.id);
      if (subscribers.size === 0) {
        this.channelSubscribers.delete(channel);
      }
    }

    this.sendMessage(client, { type: 'unsubscribed', channel });
  }

  /**
   * Handle client disconnect and resource cleanup.
   */
  public handleClientDisconnect(client: ClientConnection): void {
    this.clients.delete(client.id);

    // Remove from user connections
    if (client.userId) {
      const uConns = this.userConnections.get(client.userId);
      if (uConns) {
        uConns.delete(client.id);
        if (uConns.size === 0) {
          this.userConnections.delete(client.userId);
        }
      }
    }

    // Remove from channel subscriptions
    for (const ch of client.subscriptions) {
      const set = this.channelSubscribers.get(ch);
      if (set) {
        set.delete(client.id);
        if (set.size === 0) {
          this.channelSubscribers.delete(ch);
        }
      }
    }

    try {
      if (client.socket.readyState === WebSocket.OPEN || client.socket.readyState === WebSocket.CONNECTING) {
        client.socket.terminate();
      }
    } catch (e) {
      // Ignore termination error
    }
  }

  private registerChannelSubscriber(channel: string, connectionId: string): void {
    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(connectionId);
  }

  /**
   * Connect EventBus events to WebSocket clients.
   */
  private initEventBusBridge(): void {
    // 1. Public Market Events
    const unsubPublic = this.bus.subscribeAll((event: MarketEvent) => {
      // 1. Public Market Events
      if (event.channel && !event.channel.startsWith('user:')) {
        this.broadcastToChannel(event.channel, {
          type: 'event',
          channel: event.channel,
          data: event.payload,
          timestamp: event.timestamp,
        });
      }

      // 2. Private Domain Events (directed to specific authenticated user)
      if (event.userId) {
        let privateChannel = event.channel && event.channel.startsWith('user:') ? event.channel : 'user:orders';
        if (!event.channel || !event.channel.startsWith('user:')) {
          if (event.type.includes('trade')) privateChannel = 'user:trades';
          else if (event.type.includes('balance') || event.type.includes('ledger')) privateChannel = 'user:balances';
          else if (event.type.includes('position') || event.type.includes('liquidat')) privateChannel = 'user:positions';
        }

        this.sendToUser(event.userId, privateChannel, {
          type: 'event',
          channel: privateChannel,
          data: event.payload,
          timestamp: event.timestamp,
        });
      }
    });

    this.busUnsubscribers.push(unsubPublic);
  }

  /**
   * Broadcast message to all clients subscribed to a public or private channel.
   */
  public broadcastToChannel(channel: string, message: ServerWsMessage): void {
    const subscriberIds = this.channelSubscribers.get(channel);
    if (!subscriberIds || subscriberIds.size === 0) return;

    for (const connId of subscriberIds) {
      const client = this.clients.get(connId);
      if (client && client.socket.readyState === WebSocket.OPEN) {
        this.sendMessage(client, message);
      }
    }
  }

  /**
   * Send private message to all active authorized connections belonging to a user.
   */
  public sendToUser(userId: string, channel: string, message: ServerWsMessage): void {
    const connIds = this.userConnections.get(userId);
    if (!connIds || connIds.size === 0) return;

    for (const connId of connIds) {
      const client = this.clients.get(connId);
      if (client && client.subscriptions.has(channel) && client.socket.readyState === WebSocket.OPEN) {
        this.sendMessage(client, message);
      }
    }
  }


  /**
   * Low-level safe send with backpressure buffer check.
   */
  public sendMessage(client: ClientConnection, message: ServerWsMessage): void {
    try {
      if (client.socket.readyState !== WebSocket.OPEN) return;

      // Check socket backpressure
      if (client.socket.bufferedAmount > 1048576) {
        // 1MB buffer exceeded: slow client protection
        logger.warn('Client bufferedAmount exceeded threshold, dropping slow connection', { connectionId: client.id });
        client.socket.close(1008, 'Slow client dropped due to buffer overflow');
        this.handleClientDisconnect(client);
        return;
      }

      client.socket.send(JSON.stringify(message));
    } catch (err: any) {
      logger.warn('Failed to send WebSocket message to client', { connectionId: client.id, error: err.message });
    }
  }

  public sendError(client: ClientConnection, code: string, message: string): void {
    this.sendMessage(client, {
      type: 'error',
      code,
      message,
      timestamp: Date.now(),
    });
  }

  /**
   * Start heartbeat ping timer to prune dead connections.
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);

    this.heartbeatInterval = setInterval(() => {
      const now = Date.now();
      for (const [connId, client] of this.clients.entries()) {
        if (now - client.lastHeartbeat > this.heartbeatIntervalMs * 2) {
          logger.info('Pruning stale dead WebSocket connection', { connectionId: connId });
          client.socket.terminate();
          this.handleClientDisconnect(client);
        } else if (client.socket.readyState === WebSocket.OPEN) {
          try {
            client.socket.ping();
          } catch (e) {
            // Ignore ping errors
          }
        }
      }
    }, this.heartbeatIntervalMs);
  }

  public getConnectedClientsCount(): number {
    return this.clients.size;
  }

  public getSubscribersCount(channel: string): number {
    return this.channelSubscribers.get(channel)?.size || 0;
  }

  public close(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const unsub of this.busUnsubscribers) {
      unsub();
    }
    this.busUnsubscribers = [];

    for (const client of this.clients.values()) {
      try {
        client.socket.terminate();
      } catch (e) {}
    }

    this.clients.clear();
    this.userConnections.clear();
    this.channelSubscribers.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }
  }
}

export const webSocketGateway = new WebSocketGateway();
