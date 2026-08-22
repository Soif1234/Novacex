import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkerSupervisor, IManagedWorker } from '../src/workers/WorkerSupervisor';

describe('Phase 8.1: WorkerSupervisor Lifecycle & Isolation Unit Tests', () => {
  let supervisor: WorkerSupervisor;

  beforeEach(() => {
    supervisor = new WorkerSupervisor();
  });

  it('1. Initializes with all 5 core default background workers registered', () => {
    const workerNames = supervisor.getWorkerNames();
    expect(workerNames).toContain('LiquidationWorker');
    expect(workerNames).toContain('FundingWorker');
    expect(workerNames).toContain('ReconciliationWorker');
    expect(workerNames).toContain('KlineService');
    expect(workerNames).toContain('ConditionalTriggerService');
    expect(workerNames.length).toBe(5);
  });

  it('2. Starts all registered workers cleanly in sequence', async () => {
    const startMocks: Record<string, ReturnType<typeof vi.fn>> = {};
    const testSupervisor = new WorkerSupervisor();

    const workerNames = ['WorkerA', 'WorkerB', 'WorkerC'];
    for (const name of workerNames) {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const stopFn = vi.fn().mockResolvedValue(undefined);
      startMocks[name] = startFn;

      testSupervisor.register({
        name,
        start: startFn,
        stop: stopFn,
        getStatus: () => ({ isRunning: true }),
      });
    }

    await testSupervisor.startAll();

    for (const name of workerNames) {
      expect(startMocks[name]).toHaveBeenCalledTimes(1);
    }

    const statuses = testSupervisor.getStatuses();
    expect(statuses['WorkerA']).toEqual({ isRunning: true });
    expect(statuses['WorkerB']).toEqual({ isRunning: true });
  });

  it('3. Stops all registered workers cleanly during shutdown', async () => {
    const stopMocks: Record<string, ReturnType<typeof vi.fn>> = {};
    const testSupervisor = new WorkerSupervisor();

    const workerNames = ['Worker1', 'Worker2'];
    for (const name of workerNames) {
      const startFn = vi.fn().mockResolvedValue(undefined);
      const stopFn = vi.fn().mockResolvedValue(undefined);
      stopMocks[name] = stopFn;

      testSupervisor.register({
        name,
        start: startFn,
        stop: stopFn,
        getStatus: () => ({ isRunning: false }),
      });
    }

    await testSupervisor.startAll();
    await testSupervisor.stopAll();

    for (const name of workerNames) {
      expect(stopMocks[name]).toHaveBeenCalledTimes(1);
    }
  });

  it('4. Provides error boundary isolation on startup failure', async () => {
    const testSupervisor = new WorkerSupervisor();

    const normalWorkerStart = vi.fn().mockResolvedValue(undefined);
    const normalWorker2Start = vi.fn().mockResolvedValue(undefined);
    const failingWorkerStart = vi.fn().mockRejectedValue(new Error('Simulated worker crash'));

    testSupervisor.register({
      name: 'NormalWorker1',
      start: normalWorkerStart,
      stop: vi.fn(),
    });

    testSupervisor.register({
      name: 'FailingWorker',
      start: failingWorkerStart,
      stop: vi.fn(),
    });

    testSupervisor.register({
      name: 'NormalWorker2',
      start: normalWorker2Start,
      stop: vi.fn(),
    });

    // startAll should not throw and should still start NormalWorker1 & NormalWorker2
    await expect(testSupervisor.startAll()).resolves.not.toThrow();

    expect(normalWorkerStart).toHaveBeenCalledTimes(1);
    expect(failingWorkerStart).toHaveBeenCalledTimes(1);
    expect(normalWorker2Start).toHaveBeenCalledTimes(1);
  });

  it('5. Provides error boundary isolation on shutdown failure', async () => {
    const testSupervisor = new WorkerSupervisor();

    const normalWorkerStop = vi.fn().mockResolvedValue(undefined);
    const failingWorkerStop = vi.fn().mockRejectedValue(new Error('Simulated stop crash'));

    testSupervisor.register({
      name: 'NormalWorker',
      start: vi.fn(),
      stop: normalWorkerStop,
    });

    testSupervisor.register({
      name: 'FailingWorker',
      start: vi.fn(),
      stop: failingWorkerStop,
    });

    await testSupervisor.startAll();
    await expect(testSupervisor.stopAll()).resolves.not.toThrow();

    expect(normalWorkerStop).toHaveBeenCalledTimes(1);
    expect(failingWorkerStop).toHaveBeenCalledTimes(1);
  });

  it('6. Supports dynamic worker registration and unregistration', () => {
    const testSupervisor = new WorkerSupervisor();
    const customWorker: IManagedWorker = {
      name: 'TelemetryWorker',
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: () => ({ isRunning: true, custom: 123 }),
    };

    testSupervisor.register(customWorker);
    expect(testSupervisor.getWorkerNames()).toContain('TelemetryWorker');

    const statuses = testSupervisor.getStatuses();
    expect(statuses['TelemetryWorker']).toEqual({ isRunning: true, custom: 123 });

    testSupervisor.unregister('TelemetryWorker');
    expect(testSupervisor.getWorkerNames()).not.toContain('TelemetryWorker');
  });
});
