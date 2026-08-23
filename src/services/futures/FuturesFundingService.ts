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
    public getNextFundingTime() { return Date.now(); }
    public settleFunding() {}
    public reset() {}
    public setFundingIntervalMs(ms: number) {}
  private fundingRateStr = '0.0001'; 
  private nextFundingTime: number = Date.now() + 8 * 60 * 60 * 1000;
  
  constructor() {}

  public subscribe(callback: () => void): () => void {
    return () => {};
  }

  public getFundingRate(): string {
    return this.fundingRateStr;
  }

  public getTimeUntilNextFunding(): number {
    const now = Date.now();
    return Math.max(0, this.nextFundingTime - now);
  }

  public getHistory(accountId?: string): FundingHistory[] {
    // No backend endpoint for funding history yet, so omit history.
    return [];
  }
}

export const futuresFundingService = new FuturesFundingService();
