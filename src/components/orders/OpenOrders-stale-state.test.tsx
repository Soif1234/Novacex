import React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import { expect, test, describe, beforeEach, afterEach, vi } from 'vitest';
import { OpenOrders } from './OpenOrders';
import { orderCoreService } from '../../services/orders/OrderCoreService';
import { orderService } from '../../services/OrderService';
import { futuresOrderService } from '../../services/futures/FuturesOrderService';
import { apiClient } from '../../services/api/client';
import { wsClient } from '../../services/websocket/wsClient';

let mockCurrentUser: { id: string } | null = { id: 'account_A' };

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ user: mockCurrentUser }),
}));

describe('PHASE 15D-4 / HIGH-02: Authoritative Backend Order State & Stale State Elimination', () => {
  let wsCallbacks: { [channel: string]: ((data: any) => void)[] } = {};
  let statusCallbacks: ((status: string) => void)[] = [];

  beforeEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
    orderCoreService.reset();
    mockCurrentUser = { id: 'account_A' };

    wsCallbacks = {};
    statusCallbacks = [];

    vi.spyOn(wsClient, 'subscribe').mockImplementation((channel: string, cb: any) => {
      if (!wsCallbacks[channel]) wsCallbacks[channel] = [];
      wsCallbacks[channel].push(cb);
      return () => {
        wsCallbacks[channel] = wsCallbacks[channel].filter(c => c !== cb);
      };
    });

    vi.spyOn(wsClient, 'onStatusChange').mockImplementation((cb: any) => {
      statusCallbacks.push(cb);
      return () => {
        statusCallbacks = statusCallbacks.filter(c => c !== cb);
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // Scenario A: Initial mount triggers backend fetch (proves no silent reliance on sessionStorage)
  // --------------------------------------------------------------------------
  test('Scenario A: Initial mount triggers backend fetch for spot and futures orders', async () => {
    const spotSpy = vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        return [
          {
            id: 'ord-spot-1',
            accountId: 'account_A',
            symbol: 'BTCUSDT',
            side: 'BUY',
            type: 'LIMIT',
            price: '50000',
            quantity: '1.0',
            filledQuantity: '0',
            remainingQuantity: '1.0',
            status: 'OPEN',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
      }
      if (url === '/futures/orders') {
        return [];
      }
      return [];
    });

    render(<OpenOrders />);

    await waitFor(() => {
      expect(spotSpy).toHaveBeenCalledWith('/spot/orders');
      expect(spotSpy).toHaveBeenCalledWith('/futures/orders');
      expect(screen.getAllByText('BTCUSDT').length).toBeGreaterThanOrEqual(1);
      expect(screen.getByText('50000', { exact: false })).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario B: Order filled by background worker while tab closed is NOT shown as OPEN upon returning
  // --------------------------------------------------------------------------
  test('Scenario B: Order filled by background worker is reconciled to FILLED and removed from OpenOrders display', async () => {
    // Seed orderCoreService with a previously pending/open order
    orderCoreService.createOrder({
      id: 'ord-fill-bg',
      userId: 'account_A',
      symbol: 'BTCUSDT',
      market: 'SPOT',
      side: 'BUY',
      type: 'LIMIT',
      quantity: '1.0',
      price: '50000',
      executedQuantity: '0',
      remainingQuantity: '1.0',
      averageFillPrice: '0',
      status: 'OPEN',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Backend returns order as FILLED (e.g. background match engine or TP/SL filled it)
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        return [
          {
            id: 'ord-fill-bg',
            accountId: 'account_A',
            symbol: 'BTCUSDT',
            side: 'BUY',
            type: 'LIMIT',
            price: '50000',
            quantity: '1.0',
            filledQuantity: '1.0',
            remainingQuantity: '0',
            status: 'FILLED',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    render(<OpenOrders />);

    // Order should NOT appear in open orders because its authoritative backend status is FILLED
    await waitFor(() => {
      expect(screen.queryByText('BTCUSDT')).toBeNull();
      expect(screen.getByText('No open orders')).toBeDefined();
    });

    // Check that core service also recorded the authoritative FILLED status
    const coreOrder = orderCoreService.getOrders('account_A').find(o => o.id === 'ord-fill-bg');
    expect(coreOrder?.status).toBe('FILLED');
  });

  // --------------------------------------------------------------------------
  // Scenario C: Order cancelled by background worker while tab closed is NOT shown as OPEN upon returning
  // --------------------------------------------------------------------------
  test('Scenario C: Order cancelled by background worker is reconciled and not displayed as OPEN', async () => {
    orderCoreService.createOrder({
      id: 'ord-cancel-bg',
      userId: 'account_A',
      symbol: 'ETHUSDT',
      market: 'SPOT',
      side: 'SELL',
      type: 'LIMIT',
      quantity: '2.0',
      price: '3000',
      executedQuantity: '0',
      remainingQuantity: '2.0',
      averageFillPrice: '0',
      status: 'OPEN',
      fee: '0',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    // Backend returns it as CANCELLED (or omits it from open orders, triggering reconciliation)
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        return [
          {
            id: 'ord-cancel-bg',
            accountId: 'account_A',
            symbol: 'ETHUSDT',
            side: 'SELL',
            type: 'LIMIT',
            price: '3000',
            quantity: '2.0',
            filledQuantity: '0',
            remainingQuantity: '2.0',
            status: 'CANCELLED',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    render(<OpenOrders />);

    await waitFor(() => {
      expect(screen.queryByText('ETHUSDT')).toBeNull();
      expect(screen.getByText('No open orders')).toBeDefined();
    });

    const coreOrder = orderCoreService.getOrders('account_A').find(o => o.id === 'ord-cancel-bg');
    expect(coreOrder?.status).toBe('CANCELLED');
  });

  // --------------------------------------------------------------------------
  // Scenario D: Resting LIMIT order filled becomes visible as FILLED/PARTIALLY_FILLED upon return/reconnect
  // --------------------------------------------------------------------------
  test('Scenario D: Resting LIMIT order updated by match engine updates remaining quantity and status', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        return [
          {
            id: 'ord-limit-partial',
            accountId: 'account_A',
            symbol: 'BTCUSDT',
            side: 'BUY',
            type: 'LIMIT',
            price: '62000',
            quantity: '2.0',
            filledQuantity: '0.8',
            remainingQuantity: '1.2',
            status: 'PARTIALLY_FILLED',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    render(<OpenOrders />);

    await waitFor(() => {
      expect(screen.getByText('PARTIALLY_FILLED', { exact: false })).toBeDefined();
      expect(screen.getByText('(PARTIAL)', { exact: false })).toBeDefined();
    });

    const coreOrder = orderCoreService.getOrders('account_A').find(o => o.id === 'ord-limit-partial');
    expect(coreOrder?.remainingQuantity).toBe('1.2');
    expect(coreOrder?.executedQuantity).toBe('0.8');
    expect(coreOrder?.status).toBe('PARTIALLY_FILLED');
  });

  // --------------------------------------------------------------------------
  // Scenario E: Switch account A -> account B never displays account A orders
  // --------------------------------------------------------------------------
  test('Scenario E: Switching accounts clears Account A orders and queries Account B orders', async () => {
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        if (mockCurrentUser?.id === 'account_A') {
          return [
            {
              id: 'ord-user-A',
              accountId: 'account_A',
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '1.0',
              filledQuantity: '0',
              remainingQuantity: '1.0',
              status: 'OPEN',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ];
        } else {
          return [
            {
              id: 'ord-user-B',
              accountId: 'account_B',
              symbol: 'SOLUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '150',
              quantity: '10.0',
              filledQuantity: '0',
              remainingQuantity: '10.0',
              status: 'OPEN',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ];
        }
      }
      return [];
    });

    const { rerender } = render(<OpenOrders />);

    await waitFor(() => {
      expect(screen.getAllByText('BTCUSDT').length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText('SOLUSDT')).toBeNull();
    });

    // Switch account to account_B
    mockCurrentUser = { id: 'account_B' };
    rerender(<OpenOrders />);

    await waitFor(() => {
      // Account A order must NEVER be visible
      expect(screen.queryByText('BTCUSDT')).toBeNull();
      // Account B order is displayed
      expect(screen.getAllByText('SOLUSDT').length).toBeGreaterThanOrEqual(1);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario F: Pre-existing sessionStorage data is NOT used as authoritative truth
  // --------------------------------------------------------------------------
  test('Scenario F: Pre-seeded sessionStorage does not override fresh backend data', async () => {
    // Seed sessionStorage with stale fake order
    sessionStorage.setItem(
      'demo_core_orders',
      JSON.stringify([
        {
          id: 'stale-fake-order',
          userId: 'account_A',
          symbol: 'DOGEUSDT',
          market: 'SPOT',
          side: 'BUY',
          type: 'LIMIT',
          quantity: '1000',
          price: '0.1',
          executedQuantity: '0',
          remainingQuantity: '1000',
          averageFillPrice: '0',
          status: 'OPEN',
          fee: '0',
          createdAt: Date.now() - 100000,
          updatedAt: Date.now() - 100000,
        },
      ])
    );

    // Backend returns actual authoritative state: an empty open orders list
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      return [];
    });

    render(<OpenOrders />);

    await waitFor(() => {
      // Stale fake order must NOT be displayed
      expect(screen.queryByText('DOGEUSDT')).toBeNull();
      expect(screen.getByText('No open orders')).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario G: Real-time WebSocket order update overrides any in-memory state
  // --------------------------------------------------------------------------
  test('Scenario G: WebSocket user:orders event triggers re-sync with authoritative backend', async () => {
    let callCount = 0;
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        callCount++;
        if (callCount === 1) {
          return [
            {
              id: 'ord-ws-live',
              accountId: 'account_A',
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '1.0',
              filledQuantity: '0',
              remainingQuantity: '1.0',
              status: 'OPEN',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ];
        } else {
          // Live execution filled the order on the backend
          return [
            {
              id: 'ord-ws-live',
              accountId: 'account_A',
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '1.0',
              filledQuantity: '1.0',
              remainingQuantity: '0',
              status: 'FILLED',
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          ];
        }
      }
      return [];
    });

    render(<OpenOrders />);

    await waitFor(() => {
      expect(screen.getAllByText('BTCUSDT').length).toBeGreaterThanOrEqual(1);
    });

    // Simulate backend sending a user:orders WS push
    act(() => {
      if (wsCallbacks['user:orders']) {
        wsCallbacks['user:orders'].forEach(cb => cb({ type: 'order_update' }));
      }
    });

    // Re-fetch occurs and order status is updated to FILLED, removing it from OpenOrders
    await waitFor(() => {
      expect(screen.queryByText('BTCUSDT')).toBeNull();
      expect(screen.getByText('No open orders')).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Scenario H: WebSocket reconnect triggers backend reconciliation
  // --------------------------------------------------------------------------
  test('Scenario H: WebSocket status change to CONNECTED triggers backend reconciliation', async () => {
    let fetchCount = 0;
    vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/spot/orders') {
        fetchCount++;
        return [];
      }
      return [];
    });

    render(<OpenOrders />);

    await waitFor(() => {
      expect(fetchCount).toBeGreaterThanOrEqual(1);
    });

    const previousCount = fetchCount;

    // Simulate WebSocket reconnection
    act(() => {
      statusCallbacks.forEach(cb => cb('CONNECTED'));
    });

    await waitFor(() => {
      expect(fetchCount).toBeGreaterThan(previousCount);
    });
  });

  // --------------------------------------------------------------------------
  // Scenario I: Position display reflects backend /api/v1/futures/positions
  // --------------------------------------------------------------------------
  test('Scenario I: Futures positions are fetched directly from authoritative backend endpoint', async () => {
    const positionsSpy = vi.spyOn(apiClient, 'get').mockImplementation(async (url: string) => {
      if (url === '/futures/positions') {
        return [
          {
            id: 'pos-authoritative-1',
            accountId: 'account_A',
            symbol: 'BTCUSDT',
            side: 'LONG',
            quantity: '2.5',
            entryPrice: '60000',
            markPrice: '61000',
            leverage: 10,
            marginMode: 'ISOLATED',
            status: 'OPEN',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ];
      }
      return [];
    });

    const positions = await futuresOrderService.fetchPositionsFromBackend('account_A');

    expect(positionsSpy).toHaveBeenCalledWith('/futures/positions');
    expect(positions.length).toBe(1);
    expect(positions[0].positionId).toBe('pos-authoritative-1');
    expect(positions[0].quantity).toBe('2.5');
    expect(positions[0].entryPrice).toBe('60000');
  });

  // --------------------------------------------------------------------------
  // Scenario J: No frontend financial mutation (no client-side matching, no local balance/fee computation)
  // --------------------------------------------------------------------------
  test('Scenario J: Order cancellation delegates to authoritative backend REST endpoint without client matching', async () => {
    const postSpy = vi.spyOn(apiClient, 'post').mockResolvedValue({
      id: 'ord-to-cancel',
      status: 'CANCELLED',
    });

    await orderService.cancelOrder('ord-to-cancel');

    expect(postSpy).toHaveBeenCalledWith('/spot/orders/ord-to-cancel/cancel');
  });

  // --------------------------------------------------------------------------
  // Scenario K: Existing API payloads remain unchanged
  // --------------------------------------------------------------------------
  test('Scenario K: Spot and futures backend API endpoint contracts are preserved', async () => {
    const getSpy = vi.spyOn(apiClient, 'get').mockResolvedValue([]);

    await orderService.fetchOrdersFromBackend('account_A');
    expect(getSpy).toHaveBeenCalledWith('/spot/orders');

    await futuresOrderService.fetchOrdersFromBackend('account_A');
    expect(getSpy).toHaveBeenCalledWith('/futures/orders');
  });
});
