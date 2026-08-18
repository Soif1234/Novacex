import { TradeFill } from '../../types/orderCore';

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
            const data = localStorage.getItem(this.persistKey);
            if (data) {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) this.fills = parsed.filter(item => item && typeof item === "object");
            }
        } catch (e) {
            console.error('Failed to load trade fills', e);
        }
    }

    private save() {
        if (!this.persist) return;
        try {
            localStorage.setItem(this.persistKey, JSON.stringify(this.fills));
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

    public getFills(): TradeFill[] {
        return [...this.fills];
    }

    public getFillsByOrder(orderId: string): TradeFill[] {
        return this.fills.filter(f => f.orderId === orderId);
    }

    public getFillsBySymbol(symbol: string): TradeFill[] {
        return this.fills.filter(f => f.symbol === symbol);
    }
    
    public getTradeHistory(userId: string): TradeFill[] {
        return this.fills.filter(f => f.userId === userId);
    }

    public reset() {
        this.fills = [];
        this.save();
        this.notify();
    }
}

export const tradeFillService = new TradeFillService(typeof window !== 'undefined');
