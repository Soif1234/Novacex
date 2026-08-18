import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, test, describe, beforeEach, vi } from 'vitest';
import { OrderHistory } from './OrderHistory';
import { orderCoreService } from '../../services/orders/OrderCoreService';
import { tradeFillService } from '../../services/orders/TradeFillService';

const mockUser = { id: 'u1' };

vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

describe('OrderHistory Component (F21C)', () => {
    beforeEach(() => {
        localStorage.clear();
        orderCoreService.reset();
        // Assume tradeFillService has a reset method or we just clear local storage
        // tradeFillService.reset();
    });

    test('1. Renders empty state', () => {
        render(<OrderHistory />);
        expect(screen.getByText('No order history yet.')).toBeDefined();
    });

    test('2. Displays filled and cancelled orders', async () => {
        orderCoreService.createOrder({
            id: 'ord1', userId: 'u1', symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT',
            quantity: '1.0', price: '60000', executedQuantity: '1.0', remainingQuantity: '0.0',
            averageFillPrice: '60000', status: 'FILLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now()
        });
        orderCoreService.createOrder({
            id: 'ord2', userId: 'u1', symbol: 'ETHUSDT', market: 'FUTURES', side: 'LONG', type: 'LIMIT',
            quantity: '10', price: '3000', executedQuantity: '0', remainingQuantity: '10',
            averageFillPrice: '0', status: 'CANCELLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now()
        });
        orderCoreService.createOrder({
            id: 'ord3', userId: 'u1', symbol: 'SOLUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT',
            quantity: '100', price: '150', executedQuantity: '0', remainingQuantity: '100',
            averageFillPrice: '0', status: 'OPEN', fee: '0', createdAt: Date.now(), updatedAt: Date.now()
        }); // OPEN should not appear

        render(<OrderHistory />);
        
        await waitFor(() => {
            expect(screen.getByText('ID: ord1')).toBeDefined();
            expect(screen.getByText('ID: ord2')).toBeDefined();
            expect(screen.queryByText('ID: ord3')).toBeNull();
        });
    });
    
    test('3. Filters orders correctly', async () => {
        orderCoreService.createOrder({
            id: 'ord1', userId: 'u1', symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT',
            quantity: '1.0', price: '60000', executedQuantity: '1.0', remainingQuantity: '0.0',
            averageFillPrice: '60000', status: 'FILLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now()
        });
        orderCoreService.createOrder({
            id: 'ord2', userId: 'u1', symbol: 'ETHUSDT', market: 'FUTURES', side: 'SHORT', type: 'LIMIT',
            quantity: '10', price: '3000', executedQuantity: '0', remainingQuantity: '10',
            averageFillPrice: '0', status: 'CANCELLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now()
        });

        render(<OrderHistory />);
        
        // Filter by symbol
        const selectSymbol = screen.getByDisplayValue('All Symbols');
        fireEvent.change(selectSymbol, { target: { value: 'BTCUSDT' } });
        await waitFor(() => {
            expect(screen.getByText('ID: ord1')).toBeDefined();
            expect(screen.queryByText('ID: ord2')).toBeNull();
        });
        
        // Reset symbol, filter by status
        fireEvent.change(selectSymbol, { target: { value: 'ALL' } });
        const selectStatus = screen.getByDisplayValue('All Status');
        fireEvent.change(selectStatus, { target: { value: 'CANCELLED' } });
        await waitFor(() => {
            expect(screen.queryByText('ID: ord1')).toBeNull();
            expect(screen.getByText('ID: ord2')).toBeDefined();
        });
        
        // Filter by Side (SHORT -> SELL equivalent)
        fireEvent.change(selectStatus, { target: { value: 'ALL' } });
        const selectSide = screen.getByDisplayValue('All Sides');
        fireEvent.change(selectSide, { target: { value: 'SELL' } });
        await waitFor(() => {
            expect(screen.queryByText('ID: ord1')).toBeNull();
            expect(screen.getByText('ID: ord2')).toBeDefined();
        });
    });

    test('4. Order details modal shows fills', async () => {
        orderCoreService.createOrder({
            id: 'ord1', userId: 'u1', symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT',
            quantity: '1.0', price: '60000', executedQuantity: '1.0', remainingQuantity: '0.0',
            averageFillPrice: '60000', status: 'FILLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now(), completedAt: Date.now()
        });
        
        // Mock getFillsByOrder
        const original = tradeFillService.getFillsByOrder;
        tradeFillService.getFillsByOrder = vi.fn().mockReturnValue([{
            id: 'fill1', orderId: 'ord1', userId: 'u1', symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY',
            quantity: '1.0', price: '60000', fee: '0.001', feeAsset: 'BTC', createdAt: Date.now()
        }]);

        render(<OrderHistory />);
        
        await waitFor(() => {
            expect(screen.getByText('ID: ord1')).toBeDefined();
        });
        
        // Click on the order card
        fireEvent.click(screen.getByText('ID: ord1'));
        
        await waitFor(() => {
            expect(screen.getByText('Order Details')).toBeDefined();
            expect(screen.getByText('Trade Fills')).toBeDefined();
            expect(screen.getAllByText('Price: 60000').length).toBeGreaterThan(0);
        });

        // Close modal
        fireEvent.click(screen.getByText('Close'));
        await waitFor(() => {
            expect(screen.queryByText('Order Details')).toBeNull();
        });
        
        tradeFillService.getFillsByOrder = original;
    });
});
