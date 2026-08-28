import { IManagedWorker } from './WorkerSupervisor';
import { eventBus } from '../services/market/event-bus';
import { MarketEvent } from '../services/market/types';
import { NotificationEventType } from '../services/notification/notification.types';
import { notificationService } from '../services/notification/notification.service';
import { logger } from '../config/logger';

export class NotificationWorker implements IManagedWorker {
  public name = 'NotificationWorker';
  private subscriptions: Array<() => void> = [];
  private isRunning = false;

  // Idempotency cache: bounded Set of processed event IDs
  private processedEventIds = new Set<string>();
  private readonly MAX_CACHE_SIZE = 1000;

  public async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    const eventsToHandle = [
      NotificationEventType.USER_REGISTERED,
      NotificationEventType.WITHDRAWAL_REQUESTED,
      NotificationEventType.WITHDRAWAL_PENDING_REVIEW,
      NotificationEventType.WITHDRAWAL_APPROVED,
      NotificationEventType.WITHDRAWAL_REJECTED,
      NotificationEventType.KYC_APPROVED
    ];

    for (const eventType of eventsToHandle) {
      const unsub = eventBus.subscribe(eventType, (event) => this.handleEventSafe(event));
      this.subscriptions.push(unsub);
    }

    logger.info('NotificationWorker started');
  }

  public stop(): void {
    this.isRunning = false;
    for (const unsub of this.subscriptions) {
      unsub();
    }
    this.subscriptions = [];
    logger.info('NotificationWorker stopped');
  }

  public getStatus(): Record<string, unknown> {
    return {
      running: this.isRunning,
      cacheSize: this.processedEventIds.size
    };
  }

  private async handleEventSafe(event: MarketEvent<any>): Promise<void> {
    if (!this.isRunning) return;

    // Idempotency check
    if (this.processedEventIds.has(event.id)) {
      logger.debug(`NotificationWorker: skipping duplicate event ${event.id}`);
      return;
    }

    // Manage cache size
    if (this.processedEventIds.size >= this.MAX_CACHE_SIZE) {
      // Remove oldest (first item in Set iterator)
      const oldest = this.processedEventIds.values().next().value;
      if (oldest) this.processedEventIds.delete(oldest);
    }

    this.processedEventIds.add(event.id);

    // Process asynchronously without blocking the EventBus caller
    // Fire and forget from the synchronous listener's perspective
    this.processWithRetry(event).catch(err => {
      // This catch acts as a final safety net; the processWithRetry handles retries.
      logger.error('NotificationWorker: unhandled error in async processing', { error: err.message, eventId: event.id });
    });
  }

  private async processWithRetry(event: MarketEvent<any>): Promise<void> {
    const maxRetries = 3;
    let attempt = 0;

    while (attempt < maxRetries && this.isRunning) {
      try {
        await notificationService.handleEvent(event.type as NotificationEventType, event.payload);
        return; // Success
      } catch (error: any) {
        attempt++;
        if (attempt >= maxRetries) {
          logger.error(`NotificationWorker: failed to process event ${event.id} after ${maxRetries} attempts`, {
            type: event.type,
            error: error.message
          });
          return; // Give up, but don't crash the worker
        }

        // Exponential backoff: 1s, 2s, 4s...
        const backoffMs = Math.pow(2, attempt - 1) * 1000;
        logger.warn(`NotificationWorker: transient failure for event ${event.id}, retrying in ${backoffMs}ms`, { attempt, error: error.message });
        await new Promise(resolve => setTimeout(resolve, backoffMs));
      }
    }
  }
}
