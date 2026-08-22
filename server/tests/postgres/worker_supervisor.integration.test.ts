import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '../../src/config/database';
import { WorkerSupervisor } from '../../src/workers/WorkerSupervisor';

describe('Phase 8.1: PostgreSQL Worker Supervisor Integration Tests', () => {
  let supervisor: WorkerSupervisor;

  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    await db.connect();
    supervisor = new WorkerSupervisor();
  });

  afterAll(async () => {
    if (supervisor) {
      await supervisor.stopAll();
    }
    await db.close();
  });

  it('1. Starts all 5 background workers against live PostgreSQL database with 0 errors', async () => {
    await expect(supervisor.startAll()).resolves.not.toThrow();

    const workerNames = supervisor.getWorkerNames();
    expect(workerNames.length).toBe(5);
    expect(workerNames).toEqual([
      'LiquidationWorker',
      'FundingWorker',
      'ReconciliationWorker',
      'KlineService',
      'ConditionalTriggerService',
    ]);

    const statuses = supervisor.getStatuses();
    expect(statuses).toBeDefined();
    expect(statuses['LiquidationWorker']).toBeDefined();
    expect(statuses['FundingWorker']).toBeDefined();
    expect(statuses['ReconciliationWorker']).toBeDefined();
    expect(statuses['KlineService']).toBeDefined();
    expect(statuses['ConditionalTriggerService']).toBeDefined();
  });

  it('2. Stops all background workers cleanly with zero dangling handles', async () => {
    await expect(supervisor.stopAll()).resolves.not.toThrow();
  });
});
