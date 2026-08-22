import { reconciliationService, ReconciliationService } from '../services/compliance/reconciliation.service';
import { logger } from '../config/logger';

export class ReconciliationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;
  private isProcessing = false;

  constructor(
    private pollIntervalMs: number = 1000 * 60 * 10, // default 10 minutes
    private service: ReconciliationService = reconciliationService
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting autonomous balance reconciliation worker', {
      intervalMs: this.pollIntervalMs,
    });

    // Run first audit sweep on startup
    this.sweep().catch(err => {
      logger.error('Error in initial reconciliation worker run', { error: err });
    });

    this.intervalId = setInterval(() => {
      this.sweep().catch(err => {
        logger.error('Error in scheduled reconciliation worker loop', { error: err });
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped autonomous balance reconciliation worker');
    }
  }

  private async sweep(): Promise<void> {
    if (!this.isRunning || this.isProcessing) return;
    this.isProcessing = true;

    try {
      const report = await this.service.runReconciliation('SYSTEM_WORKER');
      if (report.status === 'PASSED') {
        logger.info('Automated balance reconciliation completed successfully', {
          reportId: report.id,
          accountsChecked: report.accountsChecked,
        });
      } else {
        logger.warn('Automated balance reconciliation detected financial discrepancies', {
          reportId: report.id,
          discrepanciesCount: report.discrepanciesCount,
        });
      }
    } catch (err: any) {
      logger.error('Unhandled exception during reconciliation worker sweep', {
        error: err.message,
      });
    } finally {
      this.isProcessing = false;
    }
  }
}

export const reconciliationWorker = new ReconciliationWorker();
