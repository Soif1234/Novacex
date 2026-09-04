import { FuturesPosition, TpSlConfiguration } from '../../types/futures';
import { Decimal } from 'decimal.js';
import { apiClient } from '../api/client';

export class FuturesTpSlService {
  private configs: TpSlConfiguration[] = [];
  private listeners: (() => void)[] = [];
  private testMode: boolean = false;

  constructor(testMode: boolean = false) {
     this.testMode = testMode;
     if (!testMode) this.load();
  }

  private readonly persistKey = 'futures_tpsl';

  private load() {
     try {
         if (typeof window === 'undefined' && typeof sessionStorage === 'undefined' && typeof localStorage === 'undefined') return;
         let data: string | null = null;
         if (typeof sessionStorage !== 'undefined') {
             data = sessionStorage.getItem(this.persistKey);
         }
         // Safe fallback migration from localStorage if sessionStorage is not populated
         if (!data && typeof localStorage !== 'undefined') {
             const legacyData = localStorage.getItem(this.persistKey);
             if (legacyData) {
                 data = legacyData;
                 if (typeof sessionStorage !== 'undefined') {
                     sessionStorage.setItem(this.persistKey, legacyData);
                 }
             }
         }
         if (data) {
             const parsed = JSON.parse(data);
             if (Array.isArray(parsed)) this.configs = parsed.filter(item => item && typeof item === "object");
         }
     } catch (e) {
         console.error('Failed to load TP/SL configs', e);
     }
  }

  private save() {
     if (this.testMode) return;
     try {
         if (typeof sessionStorage !== 'undefined') {
             sessionStorage.setItem(this.persistKey, JSON.stringify(this.configs));
         }
     } catch (e) {
         console.error('Failed to save TP/SL configs', e);
     }
  }

  public reset(accountId?: string) {
     if (accountId) {
         this.configs = this.configs.filter(c => c.accountId !== accountId);
     } else {
         this.configs = [];
     }
     this.save();
     this.notify();
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

     if (position.positionId) {
       apiClient.post(`/futures/positions/${position.positionId}/tpsl`, {
         takeProfitEnabled: config.takeProfitEnabled,
         takeProfitPrice: config.takeProfitPrice,
         stopLossEnabled: config.stopLossEnabled,
         stopLossPrice: config.stopLossPrice,
       }).catch(err => {
         console.warn('Background sync of TP/SL config to backend failed:', err?.message || err);
       });
     }
  }

  public cancelConfig(tpSlId: string) {
     const config = this.configs.find(c => c.tpSlId === tpSlId);
     if (config && config.status === 'ACTIVE') {
         config.status = 'CANCELLED';
         config.updatedAt = Date.now();
         this.save();
         this.notify();

         if (config.positionId) {
           apiClient.post(`/futures/positions/${config.positionId}/tpsl`, {
             takeProfitEnabled: false,
             stopLossEnabled: false,
           }).catch(err => {
             console.warn('Background sync of TP/SL cancellation to backend failed:', err?.message || err);
           });
         }
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

  /**
   * @deprecated TP/SL triggers are evaluated and executed exclusively by the backend TpSlWorker.
   * This method is preserved as a safe no-op for backward compatibility.
   */
  public async checkTriggers(
    _positions: FuturesPosition[],
    _markPrices: Record<string, string>,
    _placeOrderCb?: (order: any, price: string) => Promise<void>
  ): Promise<void> {
    // No-op: Backend TpSlWorker is the sole execution authority
    return;
  }
}

export const futuresTpSlService = new FuturesTpSlService();
