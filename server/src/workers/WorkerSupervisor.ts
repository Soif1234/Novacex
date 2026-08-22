import { logger } from '../config/logger';
import { liquidationWorker } from './LiquidationWorker';
import { fundingWorker } from './FundingWorker';
import { reconciliationWorker } from './ReconciliationWorker';
import { klineService } from '../services/market/kline.service';
import { conditionalTriggerService } from '../services/market/conditional.service';

export interface IManagedWorker {
  name: string;
  start: () => Promise<void> | void;
  stop: () => Promise<void> | void;
  getStatus?: () => Record<string, unknown>;
}

export class WorkerSupervisor {
  private workers: IManagedWorker[] = [];
  private isRunning = false;

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register({
      name: 'LiquidationWorker',
      start: () => liquidationWorker.start(),
      stop: () => liquidationWorker.stop(),
      getStatus: () => ({ isRunning: (liquidationWorker as any).isRunning ?? false }),
    });

    this.register({
      name: 'FundingWorker',
      start: () => fundingWorker.start(),
      stop: () => fundingWorker.stop(),
      getStatus: () => ({ isRunning: (fundingWorker as any).isRunning ?? false }),
    });

    this.register({
      name: 'ReconciliationWorker',
      start: () => reconciliationWorker.start(),
      stop: () => reconciliationWorker.stop(),
      getStatus: () => ({ isRunning: (reconciliationWorker as any).isRunning ?? false }),
    });

    this.register({
      name: 'KlineService',
      start: () => klineService.start(),
      stop: () => klineService.stop(),
      getStatus: () => ({ isRunning: true }),
    });

    this.register({
      name: 'ConditionalTriggerService',
      start: () => conditionalTriggerService.loadFromDatabase(),
      stop: () => {},
      getStatus: () => ({ isRunning: true }),
    });
  }

  public register(worker: IManagedWorker): void {
    const existingIndex = this.workers.findIndex(w => w.name === worker.name);
    if (existingIndex >= 0) {
      this.workers[existingIndex] = worker;
    } else {
      this.workers.push(worker);
    }
  }

  public unregister(name: string): void {
    this.workers = this.workers.filter(w => w.name !== name);
  }

  public getWorkerNames(): string[] {
    return this.workers.map(w => w.name);
  }

  public async startAll(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('WorkerSupervisor: Starting all registered background workers', {
      count: this.workers.length,
      workers: this.getWorkerNames(),
    });

    for (const worker of this.workers) {
      try {
        await worker.start();
        logger.info(`WorkerSupervisor: Successfully started worker [${worker.name}]`);
      } catch (err: any) {
        logger.error(`WorkerSupervisor: Error starting worker [${worker.name}]`, {
          worker: worker.name,
          error: err.message || String(err),
        });
      }
    }
  }

  public async stopAll(): Promise<void> {
    if (!this.isRunning) return;
    this.isRunning = false;
    logger.info('WorkerSupervisor: Stopping all background workers');

    for (const worker of this.workers) {
      try {
        await worker.stop();
        logger.info(`WorkerSupervisor: Successfully stopped worker [${worker.name}]`);
      } catch (err: any) {
        logger.error(`WorkerSupervisor: Error stopping worker [${worker.name}]`, {
          worker: worker.name,
          error: err.message || String(err),
        });
      }
    }
  }

  public getStatuses(): Record<string, any> {
    const statuses: Record<string, any> = {};
    for (const worker of this.workers) {
      try {
        statuses[worker.name] = worker.getStatus ? worker.getStatus() : { isRunning: this.isRunning };
      } catch (err: any) {
        statuses[worker.name] = { error: err.message || 'Failed to get status' };
      }
    }
    return statuses;
  }
}

export const workerSupervisor = new WorkerSupervisor();
