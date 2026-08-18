import { Order, MarketType, NormalizedOrderStatus } from '../../types/orderCore';
import { tradeFillService } from './TradeFillService';
import { Decimal } from 'decimal.js';

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
            const data = localStorage.getItem(this.persistKey);
            if (data) {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) this.orders = parsed.filter(item => item && typeof item === "object");
            }
        } catch (e) {
            console.error('Failed to load core orders', e);
        }
    }

    private save() {
        if (!this.persist) return;
        try {
            localStorage.setItem(this.persistKey, JSON.stringify(this.orders));
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
        return userId ? this.orders.filter(o => o.userId === userId || o.userId === undefined) : [...this.orders];
    }

    public getOpenOrders(userId?: string): Order[] {
        const openStatuses: NormalizedOrderStatus[] = ['NEW', 'OPEN', 'PARTIALLY_FILLED'];
        return this.orders.filter(o => openStatuses.includes(o.status) && (!userId || o.userId === userId));
    }

    public getOrderHistory(userId?: string): Order[] {
        const historyStatuses: NormalizedOrderStatus[] = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];
        return this.orders.filter(o => historyStatuses.includes(o.status) && (!userId || o.userId === userId));
    }

    public getOrdersBySymbol(symbol: string): Order[] {
        return this.orders.filter(o => o.symbol === symbol);
    }

    public getOrdersByMarket(market: MarketType): Order[] {
        return this.orders.filter(o => o.market === market);
    }

    public getOrdersByStatus(status: NormalizedOrderStatus): Order[] {
        return this.orders.filter(o => o.status === status);
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

    public reset() {
        this.orders = [];
        this.save();
        this.notify();
    }
}

export const orderCoreService = new OrderCoreService(typeof window !== 'undefined');
