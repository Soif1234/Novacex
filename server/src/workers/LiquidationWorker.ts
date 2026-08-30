import { futuresLiquidationService } from '../services/futures/liquidation.service';
import { db } from '../config/database';
import { logger } from '../config/logger';
import { marketDataService } from '../services/market/market.service';
import { circuitBreakerService } from '../services/system/circuit-breaker.service';

export class LiquidationWorker {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private pollIntervalMs: number = 3000) {}

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting autonomous liquidation worker', { intervalMs: this.pollIntervalMs });
    
    this.intervalId = setInterval(() => {
      this.pollAndLiquidate().catch(err => {
        logger.error('Error in liquidation worker loop', { error: err });
      });
    }, this.pollIntervalMs);
  }

  public stop() {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped autonomous liquidation worker');
    }
  }

  private async pollAndLiquidate() {
    try {
      // Circuit breaker gate: skip the entire cycle if futures trading is halted.
      const breaker = await circuitBreakerService.isSubsystemOperational('FUTURES_TRADING');
      if (!breaker.operational) {
        logger.info('Liquidation worker paused: futures trading is halted', { reason: breaker.reason });
        return;
      }

      // For efficiency, first get distinct symbols of open positions
      const symbolsRes = await db.query<any>(
        `SELECT DISTINCT symbol FROM futures_positions WHERE status = 'OPEN'`,
        []
      );

      for (const row of symbolsRes.rows) {
        if (!this.isRunning) break;
        const symbol = row.symbol;
        
        // Fetch current live mark price from the authoritative source (marketDataService).
        let markPrice: string;
        try {
          const markData = await marketDataService.getMarkPrice(symbol);
          markPrice = markData.price;
          if (!markPrice || parseFloat(markPrice) <= 0) {
            logger.error('Liquidation worker: invalid mark price from marketDataService', { symbol, markPrice });
            continue; // fail-closed: skip this symbol rather than liquidating at a bad price
          }
        } catch (err: any) {
          logger.error('Liquidation worker: failed to fetch mark price, skipping symbol', { symbol, error: err.message });
          continue; // fail-closed
        }

        // Find potentially liquidatable positions based on the live mark price
        const positionsRes = await db.query<any>(
          `SELECT id FROM futures_positions 
           WHERE status = 'OPEN' AND symbol = $1
           AND (
             (side = 'LONG' AND liquidation_price >= $2) OR
             (side = 'SHORT' AND liquidation_price <= $2)
           )`,
          [symbol, markPrice]
        );

        for (const posRow of positionsRes.rows) {
          if (!this.isRunning) break;
          
          try {
            await futuresLiquidationService.evaluateAndLiquidate(posRow.id, markPrice);
          } catch (err: any) {
            if (err.name === 'LiquidationNotEligibleError') {
              continue;
            }
            if (err.name === 'PositionAlreadyLiquidatedError' || err.name === 'PositionNotFoundError') {
              continue;
            }
            logger.error('Worker failed to evaluate position for liquidation', { positionId: posRow.id, error: err });
          }
        }
      }
    } catch (err) {
       logger.error('Liquidation worker failed to fetch open positions', { error: err });
    }
  }
}

export const liquidationWorker = new LiquidationWorker();
