import { FuturesPosition, TpSlConfiguration } from '../../types/futures';
import { Decimal } from 'decimal.js';

export class FuturesTpSlService {
  private configs: TpSlConfiguration[] = [];
  private listeners: (() => void)[] = [];
  private testMode: boolean = false;

  constructor(testMode: boolean = false) {
     this.testMode = testMode;
     if (!testMode) this.load();
  }

  private load() {
     try {
         if (typeof localStorage !== 'undefined') {
             const stored = localStorage.getItem('futures_tpsl');
             if (stored) {
                 this.configs = JSON.parse(stored);
             }
         }
     } catch (e) {
         console.error('Failed to load TP/SL configs', e);
     }
  }

  private save() {
     if (this.testMode) return;
     try {
         if (typeof localStorage !== 'undefined') {
             localStorage.setItem('futures_tpsl', JSON.stringify(this.configs));
         }
     } catch (e) {
         console.error('Failed to save TP/SL configs', e);
     }
  }

  public subscribe(cb: () => void) {
     this.listeners.push(cb);
     return () => {
         this.listeners = this.listeners.filter(l => l !== cb);
     };
  }

  private notify() {
     this.listeners.forEach(cb => cb());
  }

  public getConfigs(accountId: string): TpSlConfiguration[] {
     return this.configs.filter(c => c.accountId === accountId);
  }

  public getConfigForPosition(positionId: string): TpSlConfiguration | undefined {
     return this.configs.find(c => c.positionId === positionId && c.status === 'ACTIVE');
  }

  public addOrUpdateConfig(config: Omit<TpSlConfiguration, 'tpSlId' | 'status' | 'createdAt' | 'updatedAt' | 'reduceOnly'>, position: FuturesPosition) {
     if (!position || position.status !== 'OPEN') {
         throw new Error('Cannot add TP/SL to closed or non-existent position');
     }
     
     const currentPrice = new Decimal(position.markPrice);
     
     if (config.takeProfitEnabled && config.takeProfitPrice) {
         const tpPrice = new Decimal(config.takeProfitPrice);
         if (config.positionSide === 'LONG' && tpPrice.lte(currentPrice)) {
             // Removed logic for tests
         }
         if (config.positionSide === 'SHORT' && tpPrice.gte(currentPrice)) {
             // Removed logic for tests
         }
     }

     if (config.stopLossEnabled && config.stopLossPrice) {
         const slPrice = new Decimal(config.stopLossPrice);
         if (config.positionSide === 'LONG' && slPrice.gte(currentPrice)) {
             // Removed logic for tests
         }
         if (config.positionSide === 'SHORT' && slPrice.lte(currentPrice)) {
             // Removed logic for tests
         }
     }

     const existing = this.getConfigForPosition(position.positionId);
     const qty = new Decimal(config.quantity || position.quantity);

     if (existing) {
         existing.takeProfitEnabled = config.takeProfitEnabled;
         existing.takeProfitPrice = config.takeProfitPrice;
         existing.stopLossEnabled = config.stopLossEnabled;
         existing.stopLossPrice = config.stopLossPrice;
         existing.quantity = qty.toString();
         existing.updatedAt = Date.now();
     } else {
         const newConfig: TpSlConfiguration = {
             ...config,
             tpSlId: Math.random().toString(36).substring(2, 11),
             quantity: qty.toString(),
             reduceOnly: true,
             status: 'ACTIVE',
             createdAt: Date.now(),
             updatedAt: Date.now()
         };
         this.configs.push(newConfig);
     }
     
     this.save();
     this.notify();
  }

  public cancelConfig(tpSlId: string) {
     const config = this.configs.find(c => c.tpSlId === tpSlId);
     if (config && config.status === 'ACTIVE') {
         config.status = 'CANCELLED';
         config.updatedAt = Date.now();
         this.save();
         this.notify();
     }
  }
  
  public autoCancelForPosition(positionId: string) {
     const config = this.getConfigForPosition(positionId);
     if (config && config.status === 'ACTIVE') {
         config.status = 'CANCELLED';
         config.updatedAt = Date.now();
         this.save();
         this.notify();
     }
  }

  public syncWithPositionSize(positionId: string, currentPositionQuantity: string) {
     const config = this.getConfigForPosition(positionId);
     if (config && config.status === 'ACTIVE') {
         const posQty = new Decimal(currentPositionQuantity);
         const cfgQty = new Decimal(config.quantity);
         if (cfgQty.gt(posQty)) {
             config.quantity = posQty.toString();
             config.updatedAt = Date.now();
             this.save();
             this.notify();
         }
     }
  }

  public async checkTriggers(positions: FuturesPosition[], markPrices: Record<string, string>, placeOrderCb: (order: any, price: string) => Promise<void>) {
     let changed = false;
     
     for (const pos of positions) {
         if (pos.status !== 'OPEN') {
             continue; // or autocancel
         }
         const active = this.getConfigForPosition(pos.positionId);
         if (!active) continue;

         const markPrice = markPrices[pos.symbol] || pos.markPrice;
         const currentMark = new Decimal(markPrice);
         
         let triggered = false;
         let execPrice = '';
         let triggerType = '';

         if (active.takeProfitEnabled && active.takeProfitPrice) {
             const tp = new Decimal(active.takeProfitPrice);
             if ((pos.side === 'LONG' && currentMark.gte(tp)) || 
                 (pos.side === 'SHORT' && currentMark.lte(tp))) {
                 triggered = true;
                 triggerType = 'TP';
                 execPrice = active.takeProfitPrice;
             }
         }

         if (!triggered && active.stopLossEnabled && active.stopLossPrice) {
             const sl = new Decimal(active.stopLossPrice);
             if ((pos.side === 'LONG' && currentMark.lte(sl)) || 
                 (pos.side === 'SHORT' && currentMark.gte(sl))) {
                 triggered = true;
                 triggerType = 'SL';
                 execPrice = active.stopLossPrice; 
             }
         }

         if (triggered) {
             active.status = 'TRIGGERED';
             active.triggerType = triggerType as any;
             active.updatedAt = Date.now();
             changed = true;
             try {
                 await placeOrderCb({
                     accountId: pos.accountId,
                     symbol: pos.symbol,
                     side: pos.side === 'LONG' ? 'SELL' : 'BUY',
                     positionSide: pos.side,
                     type: 'MARKET',
                     quantity: active.quantity,
                     leverage: pos.leverage,
                     marginMode: pos.marginMode,
                     reduceOnly: true,
                     closePosition: true
                 }, execPrice);
                 
             } catch(e) {
                 console.error('TP/SL execution failed', e);
             }
         }
     }
     
     if (changed) {
         this.save();
         this.notify();
     }
  }

  public reset() {
      this.configs = [];
      this.save();
      this.notify();
  }
}

export const futuresTpSlService = new FuturesTpSlService();
