import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { Futures } from './Futures';
import { futuresOrderService } from '../services/futures/FuturesOrderService';
import React from 'react';

vi.mock('../hooks/useFuturesMarketData', () => ({
  useFuturesMarketData: vi.fn(() => ({
    data: [
      {
        symbol: 'BTCUSDT',
        baseAsset: 'BTC',
        quoteAsset: 'USDT',
        price: 50000,
        priceStr: '50000',
        markPrice: '50000',
        change24h: 2.5,
        volume: 100000,
        high24h: 52000,
        low24h: 48000,
        minimumQuantity: '0.001',
        maximumLeverage: 125,
        quantityPrecision: 3
      }
    ],
    loading: false
  }))
}));

vi.mock('../hooks/useSelectedSymbol', () => ({
  useSelectedSymbol: () => ({
    selectedSymbol: 'BTCUSDT',
    setSelectedSymbol: vi.fn()
  })
}));

vi.mock('../hooks/useTicker', () => ({
  useTicker: () => ({
    symbol: 'BTCUSDT',
    price: '50000',
    markPrice: '50000',
    change24h: '2.5',
    volume: '100000',
    high24h: '52000',
    low24h: '48000'
  })
}));

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'demo-user-1', displayName: 'Demo User' },
    isAuthenticated: true
  }),
  AuthProvider: ({ children }: any) => <>{children}</>
}));

vi.mock('../hooks/useLedger', () => ({
  useLedger: () => ({
    balances: { FUTURES_USDT: '10000', USDT: '10000' }
  })
}));

vi.mock('../components/futures/FuturesChart', () => ({
  FuturesChart: () => <div data-testid="futures-chart" />
}));

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation(query => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

import { AuthProvider } from '../contexts/AuthContext';

describe('Futures Page Double-Click Protection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Phase 1 - F. Double-click protection prevents rapid duplicate order submissions', async () => {
    let resolveOrder: any;
    const delayedPromise = new Promise(resolve => {
      resolveOrder = resolve;
    });

    const placeOrderSpy = vi.spyOn(futuresOrderService, 'placeOrder').mockImplementation(() => delayedPromise as any);

    render(
      <AuthProvider>
        <Futures />
      </AuthProvider>
    );

    // Wait for switching timer / market data to settle
    const qtyInput = await waitFor(() => screen.getByPlaceholderText('Quantity'));
    fireEvent.change(qtyInput, { target: { value: '0.1' } });

    const buyButton = await screen.findByRole('button', { name: /Buy \/ Long/i });
    expect(buyButton).toBeDefined();

    // Click once
    fireEvent.click(buyButton);

    // Rapid second and third clicks while first is in-flight
    fireEvent.click(buyButton);
    fireEvent.click(buyButton);

    // Only one order submission should have been dispatched
    expect(placeOrderSpy).toHaveBeenCalledTimes(1);

    // Button should display processing / disabled state
    expect(buyButton.textContent).toMatch(/Processing\.\.\./i);
    expect((buyButton as HTMLButtonElement).disabled).toBe(true);

    // Resolve the in-flight order
    await act(async () => {
      resolveOrder({ id: 'test-ord-1', status: 'FILLED' });
    });

    // Button reverts back to enabled state for subsequent orders
    await waitFor(() => {
      const button = screen.getByRole('button', { name: /Buy \/ Long/i }) as HTMLButtonElement;
      expect(button.disabled).toBe(false);
      expect(button.textContent).toMatch(/Buy \/ Long/i);
    });
  });
});

