import { FuturesMarket } from '../../types/futures';
import { futuresOrderService, FuturesOrderService } from './FuturesOrderService';
import { futuresMarketService, FuturesMarketService } from './FuturesMarketService';
import { futuresTpSlService, FuturesTpSlService } from './FuturesTpSlService';
import { futuresFundingService, FuturesFundingService } from './FuturesFundingService';
import { Decimal } from 'decimal.js';

export class FuturesEngineService {
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastMarkPrices: Record<string, string> = {};

  constructor(
    private orderService: FuturesOrderService = futuresOrderService,
    private marketService: FuturesMarketService = futuresMarketService,
    private tpSlService: FuturesTpSlService = futuresTpSlService,
    private fundingService: FuturesFundingService = futuresFundingService,
    private tickIntervalMs: number = 2000
  ) {}

  public start() {
    if (this.isRunning) return;
    this.isRunning = true;

    if (typeof window !== 'undefined') {
      this.timer = setInterval(() => {
        this.runCycle().catch(err => {
          console.error('Error in Futures engine cycle:', err);
        });
      }, this.tickIntervalMs);

      // Run initial cycle
      this.runCycle().catch(err => {
        console.error('Error in initial Futures engine cycle:', err);
      });
    }
  }

  public stop() {
    if (!this.isRunning) return;
    this.isRunning = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getIsRunning(): boolean {
    return this.isRunning;
  }

  public async runCycle() {
    if (!this.isRunning || this.isProcessing) return;
    try {
      const markets = await this.marketService.getMarkets();
      await this.processMarketTick(markets);
    } catch (err) {
      console.error('Futures engine runCycle error:', err);
    }
  }

  public async processMarketTick(markets: FuturesMarket[]) {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      if (!Array.isArray(markets) || markets.length === 0) return;

      // Extract valid mark prices
      const markPrices: Record<string, string> = { ...this.lastMarkPrices };
      for (const m of markets) {
        if (m && m.symbol && m.markPrice && !new Decimal(m.markPrice).isZero() && !new Decimal(m.markPrice).isNegative() && new Decimal(m.markPrice).isFinite()) {
          markPrices[m.symbol] = m.markPrice;
          this.lastMarkPrices[m.symbol] = m.markPrice;
          this.marketService.setMarketOverride(m.symbol, m);
        }
      }

      // 1. Update Mark Prices & Liquidation Checks on Positions
      // @ts-ignore
      // @ts-ignore
      await this.orderService.updateMarkPrices(markets);

      // @ts-ignore
      // 2. Evaluate & Execute Pending LIMIT and Triggered STOP orders
      // @ts-ignore
      // @ts-ignore
      await this.orderService.checkLimitOrders(markPrices);
      // @ts-ignore
      await this.orderService.checkStopOrders(markPrices);

      // 3. Evaluate & Execute TP / SL Triggers
      const openPositions = this.orderService.getAllPositions().filter(p => p.status === 'OPEN');
      if (openPositions.length > 0) {
        await this.tpSlService.checkTriggers(openPositions, markPrices, async (orderPayload) => {
          await this.orderService.placeOrder(orderPayload);
        });
      }
      // @ts-ignore

      // 4. Evaluate & Execute Funding Settlement when due
      if (this.fundingService.getTimeUntilNextFunding() <= 0 || Date.now() >= this.fundingService.getNextFundingTime()) {
      // @ts-ignore
        this.fundingService.settleFunding(this.orderService.getAllPositions(), markPrices);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public async processPriceUpdate(symbol: string, price: string) {
    if (!symbol || !price || new Decimal(price).lte(0)) return;
    this.lastMarkPrices[symbol] = price;

    const market = await this.marketService.getMarket(symbol);
    if (market) {
      market.lastPrice = price;
      market.markPrice = price;
      await this.processMarketTick([market]);
    }
  }
}

export const futuresEngineService = new FuturesEngineService();
