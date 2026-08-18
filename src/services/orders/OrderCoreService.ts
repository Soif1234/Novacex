import { Order, MarketType, NormalizedOrderStatus } from '../../types/orderCore';
import { Decimal } from 'decimal.js';
import { safeParseArray, isValidFinancialString } from '../storageUtil';

export class OrderCoreService {
    private orders: Order[] = [];
    private persistKey = 'demo_core_orders';
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
                    const parsedLegacy = safeParseArray<Order>(legacyData, item => (
                        item && typeof item.id === 'string' && typeof item.symbol === 'string' && isValidFinancialString(item.quantity) && (item.type !== 'LIMIT' || isValidFinancialString(item.price))
                    ));
                    if (parsedLegacy.length > 0) {
                        this.orders = parsedLegacy;
                        this.save();
                        return;
                    }
                }
            }

            if (data) {
                const parsed = safeParseArray<Order>(data, item => (
                    item && typeof item.id === 'string' && typeof item.symbol === 'string' && isValidFinancialString(item.quantity) && (item.type !== 'LIMIT' || isValidFinancialString(item.price))
                ));
                if (parsed.length > 0 || data.trim() === '[]') {
                    this.orders = parsed;
                }
            }
        } catch (e) {
            console.error('Failed to load core orders', e);
        }
    }

    private save() {
        if (!this.persist) return;
        try {
            if (typeof sessionStorage !== 'undefined') {
                sessionStorage.setItem(this.persistKey, JSON.stringify(this.orders));
            }
        } catch (e) {
            console.error('Failed to save core orders', e);
        }
    }

    public subscribe(callback: () => void) {
        this.subscribers.add(callback);
        return () => this.subscribers.delete(callback);
    }

    private notify() {
        this.subscribers.forEach(cb => cb());
    }

    public createOrder(order: Order) {
        // Prevent duplicate by id
        if (this.orders.some(o => o.id === order.id)) {
            return;
        }
        
        // Validation
        if (!order.quantity || new Decimal(order.quantity).lte(0) || !new Decimal(order.quantity).isFinite()) {
            // we skip throwing and just accept string validation
        }

        this.orders.unshift(order);
        this.save();
        this.notify();
    }

    public updateOrder(order: Partial<Order> & { id: string }) {
        const existing = this.orders.find(o => o.id === order.id);
        if (existing) {
            Object.assign(existing, order);
            existing.updatedAt = Date.now();
            this.save();
            this.notify();
        }
    }

    public getOrder(id: string): Order | undefined {
        return this.orders.find(o => o.id === id);
    }

    public getOrders(userId?: string): Order[] {
        return userId
            ? this.orders.filter(o => o.userId === userId || (!o.userId && userId === 'demo-user-1'))
            : [...this.orders];
    }

    public getOpenOrders(userId?: string): Order[] {
        const openStatuses: NormalizedOrderStatus[] = ['NEW', 'OPEN', 'PARTIALLY_FILLED'];
        return this.getOrders(userId).filter(o => openStatuses.includes(o.status));
    }

    public getOrderHistory(userId?: string): Order[] {
        const historyStatuses: NormalizedOrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];
        return this.getOrders(userId).filter(o => historyStatuses.includes(o.status));
    }

    public getOrdersBySymbol(symbol: string, userId?: string): Order[] {
        return this.getOrders(userId).filter(o => o.symbol === symbol);
    }

    public getOrdersByMarket(market: MarketType, userId?: string): Order[] {
        return this.getOrders(userId).filter(o => o.market === market);
    }

    public getOrdersByStatus(status: NormalizedOrderStatus, userId?: string): Order[] {
        return this.getOrders(userId).filter(o => o.status === status);
    }

    public recordExecution(orderId: string, executedQty: string, executedPrice: string) {
        const order = this.getOrder(orderId);
        if (!order) return;

        const currentExecuted = new Decimal(order.executedQuantity);
        const newExecQty = new Decimal(executedQty);
        const totalExecuted = currentExecuted.plus(newExecQty);
        
        const currentAvgPrice = new Decimal(order.averageFillPrice || 0);
        
        const oldTotalValue = currentExecuted.mul(currentAvgPrice);
        const newValue = newExecQty.mul(new Decimal(executedPrice));
        const newTotalValue = oldTotalValue.plus(newValue);
        
        const newAvgPrice = totalExecuted.isZero() ? new Decimal(0) : newTotalValue.div(totalExecuted);
        
        const remainingQty = new Decimal(order.quantity).minus(totalExecuted);

        let newStatus = order.status;
        if (totalExecuted.gte(new Decimal(order.quantity))) {
            newStatus = 'FILLED';
        } else if (totalExecuted.gt(0)) {
            newStatus = 'PARTIALLY_FILLED';
        }

        this.updateOrder({
            id: orderId,
            executedQuantity: totalExecuted.toString(),
            remainingQuantity: remainingQty.isNegative() ? '0' : remainingQty.toString(),
            averageFillPrice: newAvgPrice.toString(),
            status: newStatus,
            completedAt: newStatus === 'FILLED' ? Date.now() : undefined
        });
    }

    public reset(userId?: string) {
        if (userId) {
            this.orders = this.orders.filter(o => o.userId !== userId && (o.userId || userId !== 'demo-user-1'));
        } else {
            this.orders = [];
        }
        this.save();
        this.notify();
    }
}

export const orderCoreService = new OrderCoreService(typeof window !== 'undefined');
