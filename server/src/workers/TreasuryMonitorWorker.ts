import { TreasuryMonitorService } from '../services/treasury/treasury-monitor.service';
import { TreasuryManagerService } from '../services/treasury/treasury-manager.service';
import { logger } from '../config/logger';

export class TreasuryMonitorWorker {
  private timer: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(
    private readonly monitorService: TreasuryMonitorService,
    private readonly managerService: TreasuryManagerService,
    private readonly pollIntervalMs: number = 30000
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
      // 1. Recover any stuck intents
      await this.managerService.recoverPendingIntents();
      // 2. Scan block range
      await this.monitorService.runOnce();
    } catch (err: any) {
      logger.error(`TreasuryMonitorWorker: Error during run: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}

import { db } from '../config/database';
import { treasuryService } from '../services/treasury/treasury.service';
import { treasuryManagerService } from '../services/treasury/treasury-manager.service';
import { SafeVerificationService } from '../services/treasury/safe-verification.service';
import { env } from '../config/env';

const safeVerifier = new SafeVerificationService();
const treasuryMonitorService = new TreasuryMonitorService(treasuryService, safeVerifier, 'ETHEREUM');

export const treasuryMonitorWorker = new TreasuryMonitorWorker(
  treasuryMonitorService,
  treasuryManagerService,
  30000
);
