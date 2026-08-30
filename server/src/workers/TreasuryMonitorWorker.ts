import { TreasuryMonitorService } from '../services/treasury/treasury-monitor.service';
import { logger } from '../config/logger';

export class TreasuryMonitorWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly service: TreasuryMonitorService,
    private readonly pollIntervalMs: number = 30000,
    private readonly rpcUrl: string
  ) {}

  public start(): void {
    if (this.timer) return;
    logger.info('Starting TreasuryMonitorWorker...');
    this.timer = setInterval(() => this.run(), this.pollIntervalMs);
    // Run immediately
    setImmediate(() => this.run());
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('Stopped TreasuryMonitorWorker.');
    }
  }

  private async run(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.service.runOnce(this.rpcUrl);
    } catch (err: any) {
      logger.error(`TreasuryMonitorWorker: Error during run: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
