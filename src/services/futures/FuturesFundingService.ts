import Decimal from 'decimal.js';
import { FuturesPosition } from '../../types/futures';
import { DemoLedger } from '../ledger';
import { futuresPositionService } from './FuturesPositionService';

export interface FundingHistory {
  id: string;
  accountId: string;
  positionId: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  positionNotional: string;
  fundingRate: string;
  fundingAmount: string;
  payerReceiver: 'PAYER' | 'RECEIVER';
  timestamp: number;
  status: 'SETTLED';
}

export class FuturesFundingService {
  private fundingRateStr = '0.0001'; // 0.0100% default
  private fundingIntervalMs = 8 * 60 * 60 * 1000; // 8 hours
  private nextFundingTime: number;
  private history: FundingHistory[] = [];
  
  private persistKey = 'demo_futures_funding_history';
  private persistKeyTime = 'demo_futures_next_funding';

  private subscribers: Set<() => void> = new Set();

  constructor(private ledger: DemoLedger, private persist: boolean = true) {
    if (this.persist) {
      this.load();
    }
    
    // Initialize next funding time if not set
    if (!this.nextFundingTime || this.nextFundingTime < Date.now()) {
      this.resetNextFundingTime();
    }
  }

  private load() {
    try {
      const h = sessionStorage.getItem(this.persistKey);
      if (h) this.history = JSON.parse(h);

      const t = sessionStorage.getItem(this.persistKeyTime);
      if (t) this.nextFundingTime = parseInt(t, 10);
    } catch (e) {}
  }

  private save() {
    if (!this.persist) return;
    try {
      sessionStorage.setItem(this.persistKey, JSON.stringify(this.history));
      sessionStorage.setItem(this.persistKeyTime, this.nextFundingTime.toString());
    } catch (e) {}
  }

  public subscribe(callback: () => void) {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  private notify() {
    this.subscribers.forEach(cb => cb());
  }

  public setFundingRate(rate: string) {
    this.fundingRateStr = rate;
    this.notify();
  }

  public getFundingRate(): string {
    return this.fundingRateStr;
  }
  
  public getFundingIntervalMs(): number {
     return this.fundingIntervalMs;
  }
  
  public setFundingIntervalMs(ms: number) {
     this.fundingIntervalMs = ms;
     this.resetNextFundingTime();
  }

  public getNextFundingTime(): number {
    return this.nextFundingTime;
  }

  public getTimeUntilNextFunding(): number {
    return Math.max(0, this.nextFundingTime - Date.now());
  }

  private resetNextFundingTime() {
    this.nextFundingTime = Date.now() + this.fundingIntervalMs;
    this.save();
    this.notify();
  }

  public calculateEstimatedFunding(position: FuturesPosition, markPrice: string): string {
    const notional = new Decimal(position.quantity).mul(new Decimal(markPrice));
    const rate = new Decimal(this.fundingRateStr);
    const amount = notional.mul(rate);
    
    // For LONG: Pays if rate > 0, receives if rate < 0
    // For SHORT: Receives if rate > 0, pays if rate < 0
    if (position.side === 'LONG') {
      return amount.negated().toString(); // negative means pay, positive means receive
    } else {
      return amount.toString();
    }
  }

  public settleFunding(positions: FuturesPosition[], markPrices: Record<string, string>) {
    const now = Date.now();
    // Only settle if time has passed
    if (now < this.nextFundingTime) {
      return;
    }
    
    const eventId = `funding_${this.nextFundingTime}`;
    let processedAny = false;

    for (const pos of positions) {
      if (pos.status !== 'OPEN') continue;
      
      const markPrice = markPrices[pos.symbol] || pos.markPrice;
      const notional = new Decimal(pos.quantity).mul(new Decimal(markPrice));
      const rate = new Decimal(this.fundingRateStr);
      let amount = notional.mul(rate);
      
      let isPaying = false;
      
      if (rate.gt(0)) {
         if (pos.side === 'LONG') {
             isPaying = true;
         } else {
             isPaying = false;
         }
      } else if (rate.lt(0)) {
         if (pos.side === 'SHORT') {
             isPaying = true;
         } else {
             isPaying = false;
         }
      } else {
         // Rate is 0, no payment
         continue;
      }
      
      // Absolute amount to exchange
      const absAmount = amount.abs();
      if (absAmount.lte(0)) continue;
      
      // Check for duplicate settlement
      const alreadySettled = this.history.some(h => h.positionId === pos.positionId && h.id === eventId);
      if (alreadySettled) continue;
      
      if (isPaying) {
          const avail = new Decimal(this.ledger.getBalance('USDT'));
          let debitAmount = absAmount;
          if (avail.lt(absAmount)) {
              debitAmount = avail;
              // If we wanted to trigger liquidation here, we could. For now just take max avail.
          }
          if (debitAmount.gt(0)) {
              this.ledger.debit('USDT', debitAmount.toString(), `FUNDING_PAYMENT for ${pos.symbol} ${pos.side}`);
          }
      } else {
          this.ledger.credit('USDT', absAmount.toString(), `FUNDING_RECEIPT for ${pos.symbol} ${pos.side}`);
      }
      
      this.history.push({
         id: eventId,
         accountId: pos.accountId,
         positionId: pos.positionId,
         symbol: pos.symbol,
         side: pos.side,
         positionNotional: notional.toString(),
         fundingRate: this.fundingRateStr,
         fundingAmount: absAmount.toString(),
         payerReceiver: isPaying ? 'PAYER' : 'RECEIVER',
         timestamp: now,
         status: 'SETTLED'
      });
      processedAny = true;
    }

    this.resetNextFundingTime();
    
    if (processedAny) {
      this.save();
      this.notify();
    }
  }
  
  public getHistory(accountId: string): FundingHistory[] {
      return this.history.filter(h => h.accountId === accountId);
  }
  
  public forceSettleForTesting(positions: FuturesPosition[], markPrices: Record<string, string>) {
     this.nextFundingTime = Date.now() - 1000;
     this.settleFunding(positions, markPrices);
  }
}

// Ensure the ledger instance is shared. Assuming we pass demoLedger.
import { demoLedger } from '../ledger';
export const futuresFundingService = new FuturesFundingService(demoLedger, true);
