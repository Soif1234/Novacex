import { futuresFundingService } from '../services/futures/funding.service';
import { db } from '../config/database';
import { logger } from '../config/logger';

export class FundingWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private pollIntervalMs: number = 1000 * 60 * 15) {}

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting autonomous funding worker', { intervalMs: this.pollIntervalMs });
    
    this.pollAndSettle().catch(err => {
        logger.error('Error in funding worker startup', { error: err });
    });

    this.intervalId = setInterval(() => {
      this.pollAndSettle().catch(err => {
        logger.error('Error in funding worker loop', { error: err });
      });
    }, this.pollIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped autonomous funding worker');
    }
  }

  private async pollAndSettle() {
    try {
      const symbolsRes = await db.query<any>(
        `SELECT symbol FROM trading_pairs WHERE market_type = 'FUTURES' AND is_active = true`,
        []
      );

      for (const row of symbolsRes.rows) {
        if (!this.isRunning) break;
        const symbol = row.symbol;
        
        try {
          const result = await futuresFundingService.settleFundingInterval(symbol);
          if (result.settledPositions > 0) {
            logger.info('Funding settled for symbol', { 
                symbol, 
                settledPositions: result.settledPositions,
                rate: result.rateData?.fundingRate 
            });
          }
        } catch (err: any) {
          logger.error('Worker failed to settle funding', { symbol, error: err });
        }
      }
    } catch (err) {
       logger.error('Funding worker failed to fetch symbols', { error: err });
    }
  }
}

export const fundingWorker = new FundingWorker();
