import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { expect, test, describe, beforeEach, vi } from 'vitest';
import { OpenOrders } from './OpenOrders';
import { orderCoreService } from '../../services/orders/OrderCoreService';

const mockUser = { id: 'u1' };

vi.mock('../../services/OrderService', () => ({ orderService: { cancelOrder: vi.fn() } }));
vi.mock('../../services/futures/FuturesOrderService', () => ({ futuresOrderService: { cancelOrder: vi.fn().mockResolvedValue({}) } }));
vi.mock('../../contexts/AuthContext', () => ({ useAuth: () => ({ user: mockUser }) }));

describe('OpenOrders Component', () => {
    beforeEach(() => {
        localStorage.clear();
        orderCoreService.reset();
    });

    test('1. Renders empty state', () => {
        render(<OpenOrders />);
        expect(screen.getByText('No open orders')).toBeDefined();
    });

    test('2. Displays open orders and partially filled', async () => {
        orderCoreService.createOrder({
            id: 'ord1', userId: 'u1', symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT',
            quantity: '1.0', price: '60000', executedQuantity: '0', remainingQuantity: '1.0',
            averageFillPrice: '0', status: 'OPEN', fee: '0', createdAt: Date.now(), updatedAt: Date.now()
        });
        orderCoreService.createOrder({
            id: 'ord2', userId: 'u1', symbol: 'ETHUSDT', market: 'FUTURES', side: 'LONG', type: 'LIMIT',
            quantity: '10', price: '3000', executedQuantity: '4', remainingQuantity: '6',
            averageFillPrice: '3000', status: 'PARTIALLY_FILLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now()
        });

        render(<OpenOrders />);
        await waitFor(() => {
            expect(screen.getByText('OPEN', { exact: false })).toBeDefined();
            expect(screen.getByText('PARTIALLY_FILLED', { exact: false })).toBeDefined();
        });
    });

    test('3. Filters orders correctly', async () => {
        orderCoreService.createOrder({
            id: 'ord1', userId: 'u1', symbol: 'BTCUSDT', market: 'SPOT', side: 'BUY', type: 'LIMIT',
            quantity: '1.0', price: '60000', executedQuantity: '0', remainingQuantity: '1.0',
            averageFillPrice: '0', status: 'OPEN', fee: '0', createdAt: Date.now(), updatedAt: Date.now()
        });
        orderCoreService.createOrder({
            id: 'ord2', userId: 'u1', symbol: 'ETHUSDT', market: 'FUTURES', side: 'LONG', type: 'LIMIT',
            quantity: '10', price: '3000', executedQuantity: '4', remainingQuantity: '6',
            averageFillPrice: '3000', status: 'PARTIALLY_FILLED', fee: '0', createdAt: Date.now(), updatedAt: Date.now()
        });

        // Test 1: pre-filtered by prop
        const { unmount } = render(<OpenOrders symbol="BTCUSDT" />);
        await waitFor(() => {
            expect(screen.getByText('OPEN', { exact: false })).toBeDefined();
            expect(screen.queryByText('PARTIALLY_FILLED', { exact: false })).toBeNull(); 
        });
        unmount();
        
        // Test 2: no filter initially
        render(<OpenOrders />);
        await waitFor(() => {
            expect(screen.getByText('OPEN', { exact: false })).toBeDefined();
            expect(screen.getByText('PARTIALLY_FILLED', { exact: false })).toBeDefined();
        });
        
        // Test 3: filter by symbol
        const selectSymbol = screen.getByDisplayValue('All Symbols');
        fireEvent.change(selectSymbol, { target: { value: 'BTCUSDT' } });
        await waitFor(() => {
            expect(screen.getByText('OPEN', { exact: false })).toBeDefined();
            expect(screen.queryByText('PARTIALLY_FILLED', { exact: false })).toBeNull();
        });
        
        // Test 4: filter by market
        const selectMarket = screen.getByDisplayValue('All Markets');
        fireEvent.change(selectMarket, { target: { value: 'FUTURES' } });
        await waitFor(() => {
            expect(screen.queryByText('OPEN', { exact: false })).toBeNull();
            // Since symbol is STILL BTCUSDT, NO orders match!
            expect(screen.queryByText('PARTIALLY_FILLED', { exact: false })).toBeNull(); 
            expect(screen.getByText('No matching orders')).toBeDefined();
        });
        
        // Reset symbol filter, should see ETHUSDT again
        fireEvent.change(selectSymbol, { target: { value: 'ALL' } });
        await waitFor(() => {
            expect(screen.queryByText('OPEN', { exact: false })).toBeNull();
            expect(screen.getByText('PARTIALLY_FILLED', { exact: false })).toBeDefined();
        });
    });
});
