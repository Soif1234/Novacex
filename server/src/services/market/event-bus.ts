import { EventEmitter } from 'events';
import crypto from 'crypto';
import { MarketEvent } from './types';
import { logger } from '../../config/logger';

export type EventHandler<T = any> = (event: MarketEvent<T>) => void | Promise<void>;

export class EventBus {
  private emitter = new EventEmitter();
  private channelSubscribers = new Map<string, Set<EventHandler>>();
  private userSubscribers = new Map<string, Set<EventHandler>>();
  private allSubscribers = new Set<EventHandler>();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  /**
   * Publish a strongly typed market/domain event to the bus.
   */
  public publish<T = any>(event: MarketEvent<T>): void {
    // 1. Ensure mandatory envelope fields
    if (!event.id) {
      event.id = crypto.randomUUID();
    }
    if (!event.timestamp) {
      event.timestamp = Date.now();
    }
    if (!event.version) {
      event.version = '1.0.0';
    }

    // 2. Dispatch to event type listeners
    this.emitter.emit(event.type, event);

    // 3. Dispatch to channel listeners if channel specified
    if (event.channel) {
      const chSet = this.channelSubscribers.get(event.channel);
      if (chSet) {
        for (const handler of chSet) {
          try {
            handler(event);
          } catch (err) {
            logger.error('Error in channel event handler', { channel: event.channel, error: err });
          }
        }
      }
    }

    // 4. Dispatch to user listeners if userId specified (for private events)
    if (event.userId) {
      const userSet = this.userSubscribers.get(event.userId);
      if (userSet) {
        for (const handler of userSet) {
          try {
            handler(event);
          } catch (err) {
            logger.error('Error in user event handler', { userId: event.userId, error: err });
          }
        }
      }
    }

    // 5. Dispatch to wildcard listeners
    for (const handler of this.allSubscribers) {
      try {
        handler(event);
      } catch (err) {
        logger.error('Error in global event handler', { error: err });
      }
    }
  }

  /**
   * Subscribe to a specific event type (e.g. 'market.ticker', 'spot.trade.executed').
   */
  public subscribe<T = any>(eventType: string, handler: EventHandler<T>): () => void {
    this.emitter.on(eventType, handler);
    return () => {
      this.emitter.off(eventType, handler);
    };
  }

  /**
   * Subscribe to a channel stream (e.g. 'ticker:BTCUSDT', 'orderbook:ETHUSDT', 'user:orders').
   */
  public subscribeChannel<T = any>(channel: string, handler: EventHandler<T>): () => void {
    if (!this.channelSubscribers.has(channel)) {
      this.channelSubscribers.set(channel, new Set());
    }
    this.channelSubscribers.get(channel)!.add(handler);

    return () => {
      const set = this.channelSubscribers.get(channel);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.channelSubscribers.delete(channel);
        }
      }
    };
  }

  /**
   * Subscribe to all private events destined for a specific authenticated user.
   */
  public subscribeUser<T = any>(userId: string, handler: EventHandler<T>): () => void {
    if (!this.userSubscribers.has(userId)) {
      this.userSubscribers.set(userId, new Set());
    }
    this.userSubscribers.get(userId)!.add(handler);

    return () => {
      const set = this.userSubscribers.get(userId);
      if (set) {
        set.delete(handler);
        if (set.size === 0) {
          this.userSubscribers.delete(userId);
        }
      }
    };
  }

  /**
   * Subscribe to all events passing through the bus.
   */
  public subscribeAll<T = any>(handler: EventHandler<T>): () => void {
    this.allSubscribers.add(handler);
    return () => {
      this.allSubscribers.delete(handler);
    };
  }

  /**
   * Reset all bus subscriptions (primarily for tests).
   */
  public reset(): void {
    this.emitter.removeAllListeners();
    this.channelSubscribers.clear();
    this.userSubscribers.clear();
    this.allSubscribers.clear();
  }
}

export const eventBus = new EventBus();
