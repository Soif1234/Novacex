import { orderCoreService } from './OrderCoreService';
import { tradeFillService } from './TradeFillService';
import { Order, TradeFill, MarketType, NormalizedOrderSide, NormalizedOrderType, NormalizedOrderStatus } from '../../types/orderCore';

export function syncOrderToCore(
    id: string,
    userId: string | undefined,
    symbol: string,
    market: MarketType,
    side: NormalizedOrderSide,
    type: NormalizedOrderType,
    quantity: string,
    price: string | undefined,
    stopPrice: string | undefined,
    status: NormalizedOrderStatus,
    fee: string = '0',
    executedQuantity: string = '0',
    remainingQuantity?: string,
    averageFillPrice?: string
) {
    const existing = orderCoreService.getOrder(id);
    if (!existing) {
        orderCoreService.createOrder({
            id,
            userId,
            symbol,
            market,
            side,
            type,
            quantity,
            price,
            stopPrice,
            executedQuantity,
            remainingQuantity: remainingQuantity || quantity,
            averageFillPrice: averageFillPrice || '0',
            status,
            fee,
            createdAt: Date.now(),
            updatedAt: Date.now()
        });
    } else {
        orderCoreService.updateOrder({
            id,
            status,
            executedQuantity: executedQuantity !== undefined ? executedQuantity : existing.executedQuantity,
            remainingQuantity: remainingQuantity !== undefined ? remainingQuantity : existing.remainingQuantity,
            averageFillPrice: averageFillPrice !== undefined ? averageFillPrice : existing.averageFillPrice,
            price: price !== undefined ? price : existing.price,
            stopPrice: stopPrice !== undefined ? stopPrice : existing.stopPrice,
            fee: fee !== undefined ? fee : existing.fee,
        });
    }
}

export function syncFillToCore(
    fillId: string,
    orderId: string,
    userId: string | undefined,
    symbol: string,
    market: MarketType,
    side: NormalizedOrderSide,
    quantity: string,
    price: string,
    fee: string,
    feeAsset: string,
    realizedPnl?: string
) {
    const isNew = tradeFillService.recordFill({
        id: fillId,
        orderId,
        userId,
        symbol,
        market,
        side,
        quantity,
        price,
        fee,
        feeAsset,
        realizedPnl,
        createdAt: Date.now()
    });
    
    if (isNew) {
        orderCoreService.recordExecution(orderId, quantity, price);
    }
}
