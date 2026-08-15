import { Decimal } from 'decimal.js';
import { FuturesPosition, FuturesCalculationResult } from '../types/futures';
import { DemoLedger, demoLedger } from './ledger';
import { fetchMarketData } from './marketData';

// Maintenance Margin Rate for Demo Simulator
const MAINTENANCE_MARGIN_RATE = 0.005; // 0.5%

export class FuturesService {
  private positions: FuturesPosition[] = [];
  private subscribers: Set<() => void> = new Set();
  private persistKey = 'demo_futures_positions';

  constructor(private ledger: DemoLedger, private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  private load() {
    try {
      const data = sessionStorage.getItem(this.persistKey);
      if (data) {
        this.positions = JSON.parse(data);
      }
    } catch (e) {
      
    }
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.positions));
    } catch (e) {
      
    }
  }

  /**
   * Calculate required isolated initial margin
   */
  public static calculateMargin(size: string, entryPrice: string, leverage: number): string {
    const s = new Decimal(size);
    const p = new Decimal(entryPrice);
    const l = new Decimal(leverage);
    return s.mul(p).div(l).toString();
  }

  /**
   * Calculate isolated liquidation price
   */
  public static calculateLiquidationPrice(side: 'LONG' | 'SHORT', entryPrice: string, leverage: number): string {
    const p = new Decimal(entryPrice);
    const l = new Decimal(leverage);
    const mmr = new Decimal(MAINTENANCE_MARGIN_RATE);

    let liqPrice: Decimal;
    if (side === 'LONG') {
      // Long Liquidation Price = Entry Price * (1 - 1/Leverage + MMR)
      liqPrice = p.mul(new Decimal(1).minus(new Decimal(1).div(l)).plus(mmr));
    } else {
      // Short Liquidation Price = Entry Price * (1 + 1/Leverage - MMR)
      liqPrice = p.mul(new Decimal(1).plus(new Decimal(1).div(l)).minus(mmr));
    }

    return liqPrice.gt(0) ? liqPrice.toString() : '0';
  }

  /**
   * Calculate dynamic PNL and margin state based on live mark price
   */
  public static calculateLiveStats(position: FuturesPosition, markPrice: string): FuturesCalculationResult {
    const size = new Decimal(position.size);
    const entry = new Decimal(position.entryPrice);
    const mark = new Decimal(markPrice);
    const margin = new Decimal(position.margin);

    let unrealizedPnl: Decimal;
    if (position.side === 'LONG') {
      unrealizedPnl = mark.minus(entry).mul(size);
    } else {
      unrealizedPnl = entry.minus(mark).mul(size);
    }

    const pnlPercentage = margin.gt(0) ? unrealizedPnl.div(margin).mul(100) : new Decimal(0);
    
    // Margin Ratio = Maintenance Margin / (Position Margin + Unrealized PNL)
    const maintenanceMargin = mark.mul(size).mul(new Decimal(MAINTENANCE_MARGIN_RATE));
    const equity = margin.plus(unrealizedPnl);
    const marginRatio = equity.gt(0) ? maintenanceMargin.div(equity).mul(100) : new Decimal(100);

    return {
      unrealizedPnl: unrealizedPnl.toString(),
      pnlPercentage: pnlPercentage.toString(),
      marginRatio: marginRatio.toString()
    };
  }

  public getPositions(accountId: string): FuturesPosition[] {
    return this.positions.filter(p => p.accountId === accountId);
  }

  /**
   * Note: This fetches market data to determine execution price securely,
   * preventing client-side trust of financial values.
   */
  public async openPosition(
    accountId: string, 
    symbol: string, 
    side: 'LONG' | 'SHORT', 
    leverage: number, 
    size: string
  ): Promise<FuturesPosition> {
    const markets = await fetchMarketData();
    const baseAsset = symbol.replace('USDT', '');
    const market = markets.find(m => m.baseAsset === baseAsset);
    
    if (!market) {
      throw new Error(`Market not found for ${symbol}`);
    }
    
    const entryPrice = market.price.toString();
    const margin = FuturesService.calculateMargin(size, entryPrice, leverage);
    
    // Debit margin from ledger securely inside the service
    this.ledger.debit('USDT', margin, `futures_margin_open_${Math.random().toString(36).substring(2, 6)}`);

    const liquidationPrice = FuturesService.calculateLiquidationPrice(side, entryPrice, leverage);
    
    const position: FuturesPosition = {
      id: Math.random().toString(36).substring(2, 11),
      accountId,
      symbol,
      side,
      leverage,
      size,
      entryPrice,
      margin,
      liquidationPrice
    };

    this.positions.push(position);
    this.save();
    this.notify();
    
    return position;
  }

  /**
   * Close a position, calculate PNL from live market price, and return funds to ledger.
   */
  public async closePosition(positionId: string): Promise<{ realizedPnl: string, marginReturned: string } | null> {
    const index = this.positions.findIndex(p => p.id === positionId);
    if (index === -1) return null;
    
    const position = this.positions[index];
    
    const markets = await fetchMarketData();
    const baseAsset = position.symbol.replace('USDT', '');
    const market = markets.find(m => m.baseAsset === baseAsset);
    
    if (!market) {
      throw new Error(`Market not found for ${position.symbol}`);
    }
    
    const markPrice = market.price.toString();
    const stats = FuturesService.calculateLiveStats(position, markPrice);
    
    this.positions.splice(index, 1);
    this.save();
    this.notify();

    const totalCredit = new Decimal(position.margin).plus(new Decimal(stats.unrealizedPnl)).toString();
    if (new Decimal(totalCredit).gt(0)) {
      this.ledger.credit('USDT', totalCredit, `futures_close_${position.id}`);
    }

    return {
      realizedPnl: stats.unrealizedPnl,
      marginReturned: position.margin
    };
  }

  public reset() {
    this.positions = [];
    this.save();
    this.notify();
  }
}

export const futuresService = new FuturesService(demoLedger, typeof window !== 'undefined');
