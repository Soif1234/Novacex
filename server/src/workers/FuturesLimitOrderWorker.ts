import { db, IDatabaseConnection } from '../config/database';
import { futuresService, FuturesService, FuturesExecutionResult } from '../services/futures/futures.service';
import { developmentMarkPriceProvider, IMarkPriceProvider } from '../services/futures/mark-price.provider';
import { circuitBreakerService, CircuitBreakerService } from '../services/system/circuit-breaker.service';
import { logger } from '../config/logger';
import { decimalCompare } from '../services/ledger/decimal';

export interface RestingOrderCandidate {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  price: string;
  quantity: string;
  accountId: string;
  createdAt: Date;
}

export class FuturesLimitOrderWorker {
  private intervalId: NodeJS.Timeout | null = null;
  public isRunning = false;

  constructor(
    private readonly pollIntervalMs: number = 1000,
    private readonly futuresSvc: FuturesService = futuresService,
    private readonly markPriceProvider: IMarkPriceProvider = developmentMarkPriceProvider,
    private readonly breakerService: CircuitBreakerService = circuitBreakerService,
    private readonly database: IDatabaseConnection = db
  ) {}

  public start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    logger.info('Starting autonomous futures limit order worker', { intervalMs: this.pollIntervalMs });

    this.intervalId = setInterval(() => {
      this.pollAndExecute().catch(err => {
        logger.error('Error in futures limit order worker loop', { error: err.message });
      });
    }, this.pollIntervalMs);
  }

  public stop(): void {
    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      logger.info('Stopped autonomous futures limit order worker');
    }
  }

  public async pollAndExecute(): Promise<void> {
    if (!this.isRunning) return;

    try {
      const breaker = await this.breakerService.isSubsystemOperational('FUTURES_TRADING');
      if (!breaker.operational) {
        return;
      }

      await this.checkAndExecuteOrders();
    } catch (err: any) {
      logger.error('Error in futures limit order worker sweep', { error: err.message });
    }
  }

  /**
   * Sweeps eligible NEW resting futures limit orders with price/time priority,
   * checks authoritative mark prices, and triggers atomic execution.
   */
  public async checkAndExecuteOrders(
    overrideMarkPrices?: Record<string, string>
  ): Promise<FuturesExecutionResult[]> {
    const results: FuturesExecutionResult[] = [];

    // Query candidate NEW resting limit orders with FIFO time priority on created_at
    const ordersRes = await this.database.query<any>(
      `SELECT o.id, o.symbol, o.side, o.price, o.quantity, o.account_id AS "accountId", o.created_at AS "createdAt"
       FROM orders o
       JOIN futures_orders fo ON o.id = fo.order_id
       WHERE o.market = 'FUTURES'
         AND o.status = 'NEW'
         AND o.type = 'LIMIT'
       ORDER BY o.created_at ASC
       LIMIT 50`
    );

    for (const row of ordersRes.rows) {
      const symbol = row.symbol.trim().toUpperCase();
      let markPrice: string | undefined = overrideMarkPrices?.[symbol];

      if (!markPrice) {
        try {
          markPrice = await this.markPriceProvider.getMarkPrice(symbol);
        } catch (err: any) {
          logger.warn('Failed to resolve mark price during resting limit sweep', { symbol, error: err.message });
          continue; // fail-closed: skip symbol if price lookup fails
        }
      }

      if (!markPrice || decimalCompare(markPrice, '0') <= 0) {
        continue; // fail-closed: non-positive price
      }

      // Check crossing condition:
      // BUY limit: markPrice <= limit price
      // SELL limit: markPrice >= limit price
      const cleanPrice = row.price;
      let crosses = false;
      if (row.side === 'BUY' && decimalCompare(markPrice, cleanPrice) <= 0) {
        crosses = true;
      } else if (row.side === 'SELL' && decimalCompare(markPrice, cleanPrice) >= 0) {
        crosses = true;
      }

      if (crosses) {
        try {
          const res = await this.futuresSvc.executeRestingOrder(row.id, markPrice);
          if (res) {
            results.push(res);
          }
        } catch (err: any) {
          logger.error('Unexpected error executing resting limit order', {
            orderId: row.id,
            symbol,
            error: err.message,
          });
        }
      }
    }

    return results;
  }
}

export const futuresLimitOrderWorker = new FuturesLimitOrderWorker();
