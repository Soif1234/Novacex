import { futuresTpSlService, FuturesTpSlService } from '../services/futures/tpsl.service';
import { circuitBreakerService, CircuitBreakerService } from '../services/system/circuit-breaker.service';
import { logger } from '../config/logger';

export class TpSlWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(
    private readonly pollIntervalMs: number = 2000,
    private readonly tpslService: FuturesTpSlService = futuresTpSlService,
    private readonly breakerService: CircuitBreakerService = circuitBreakerService
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting autonomous futures TP/SL worker', { intervalMs: this.pollIntervalMs });

    this.intervalId = setInterval(() => {
      this.pollAndTrigger().catch(err => {
        logger.error('Error in TP/SL worker loop', { error: err.message });
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped autonomous futures TP/SL worker');
    }
  }

  public async pollAndTrigger(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const breaker = await this.breakerService.isSubsystemOperational('FUTURES_TRADING');
      if (!breaker.operational) {
        return;
      }

      await this.tpslService.checkAllActiveTriggers();
    } catch (err: any) {
      logger.error('Error in TP/SL worker sweep', { error: err.message });
    }
  }
}

export const tpSlWorker = new TpSlWorker();
