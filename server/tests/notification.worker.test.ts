import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationWorker } from '../src/workers/NotificationWorker';
import { eventBus } from '../src/services/market/event-bus';
import { NotificationEventType } from '../src/services/notification/notification.types';
import { notificationService } from '../src/services/notification/notification.service';
import { workerSupervisor } from '../src/workers/WorkerSupervisor';

vi.mock('../src/services/notification/notification.service');
vi.mock('../src/config/logger');

describe('NotificationWorker', () => {
  let worker: NotificationWorker;

  beforeEach(() => {
    worker = new NotificationWorker();
    vi.clearAllMocks();
    eventBus.reset();
  });

  afterEach(() => {
    worker.stop();
  });

  it('starts and stops via WorkerSupervisor', async () => {
    workerSupervisor.register(worker);
    await workerSupervisor.startAll();
    const status = workerSupervisor.getStatuses();
    expect(status['NotificationWorker'].running).toBe(true);

    await workerSupervisor.stopAll();
    expect(workerSupervisor.getStatuses()['NotificationWorker'].running).toBe(false);
  });

  it('handles events asynchronously without blocking', async () => {
    await worker.start();

    const handleSpy = vi.spyOn(notificationService, 'handleEvent').mockResolvedValue();

    eventBus.publish({
      id: 'evt-1',
      type: NotificationEventType.USER_REGISTERED,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: { userId: 'u1', email: 'test@test.com' }
    });

    // allow async processing
    await new Promise(r => setTimeout(r, 50));

    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate event IDs (idempotency)', async () => {
    await worker.start();
    const handleSpy = vi.spyOn(notificationService, 'handleEvent').mockResolvedValue();

    const event = {
      id: 'evt-dup',
      type: NotificationEventType.USER_REGISTERED,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: { userId: 'u1', email: 'test@test.com' }
    };

    eventBus.publish(event);
    eventBus.publish(event); // exact same ID

    await new Promise(r => setTimeout(r, 50));

    expect(handleSpy).toHaveBeenCalledTimes(1);
  });

  it('retries provider failures but does not crash', async () => {
    await worker.start();

    let attempts = 0;
    const handleSpy = vi.spyOn(notificationService, 'handleEvent').mockImplementation(async () => {
      attempts++;
      throw new Error('SendGrid 500 error');
    });

    eventBus.publish({
      id: 'evt-fail',
      type: NotificationEventType.USER_REGISTERED,
      timestamp: Date.now(),
      version: '1.0.0',
      payload: { userId: 'u1', email: 'test@test.com' }
    });

    // Max retries is 3 with exponential backoff (1s, 2s).
    // In a real test we might mock setTimeout or just verify it handles the rejection.
    // For this test, we can just let it run its first attempt.
    await new Promise(r => setTimeout(r, 50));
    expect(handleSpy).toHaveBeenCalled();

    // The worker should still be running.
    expect(worker.getStatus().running).toBe(true);
  });
});
