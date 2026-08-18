import { TradeFill } from '../../types/orderCore';
import { safeParseArray, isValidFinancialString } from '../storageUtil';

export class TradeFillService {
    private fills: TradeFill[] = [];
    private persistKey = 'demo_trade_fills';
    private subscribers: Set<() => void> = new Set();

    constructor(private persist: boolean = true) {
        if (this.persist) {
            this.load();
        }
    }

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
                    const parsedLegacy = safeParseArray<TradeFill>(legacyData, item => (
                        item && typeof item.id === 'string' && typeof item.symbol === 'string' && isValidFinancialString(item.quantity)
                    ));
                    if (parsedLegacy.length > 0) {
                        this.fills = parsedLegacy;
                        this.save();
                        return;
                    }
                }
            }

            if (data) {
                const parsed = safeParseArray<TradeFill>(data, item => (
                    item && typeof item.id === 'string' && typeof item.symbol === 'string' && isValidFinancialString(item.quantity)
                ));
                if (parsed.length > 0 || data.trim() === '[]') {
                    this.fills = parsed;
                }
            }
        } catch (e) {
            console.error('Failed to load trade fills', e);
        }
    }

    private save() {
        if (!this.persist) return;
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem(this.persistKey, JSON.stringify(this.fills));
            }
        } catch (e) {
            console.error('Failed to save trade fills', e);
        }
    }

    public subscribe(callback: () => void) {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    private notify() {
        this.subscribers.forEach(cb => cb());
    }

    public recordFill(fill: TradeFill): boolean {
        // Duplicate prevention by ID
        if (this.fills.some(f => f.id === fill.id)) {
            return false;
        }
        this.fills.unshift(fill);
        this.save();
        this.notify();
        return true;
    }

    public getFill(id: string): TradeFill | undefined {
        return this.fills.find(f => f.id === id);
    }

    public getFills(userId?: string): TradeFill[] {
        return userId
            ? this.fills.filter(f => f.userId === userId || (!f.userId && userId === 'demo-user-1'))
            : [...this.fills];
    }

    public getFillsByOrder(orderId: string, userId?: string): TradeFill[] {
        return this.getFills(userId).filter(f => f.orderId === orderId);
    }

    public getFillsBySymbol(symbol: string, userId?: string): TradeFill[] {
        return this.getFills(userId).filter(f => f.symbol === symbol);
    }
    
    public getTradeHistory(userId: string): TradeFill[] {
        return this.getFills(userId);
    }

    public reset(userId?: string) {
        if (userId) {
            this.fills = this.fills.filter(f => f.userId !== userId && (f.userId || userId !== 'demo-user-1'));
        } else {
            this.fills = [];
        }
        this.save();
        this.notify();
    }
}

export const tradeFillService = new TradeFillService(typeof window !== 'undefined');
