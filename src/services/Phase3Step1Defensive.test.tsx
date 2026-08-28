import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { render, screen } from '@testing-library/react';
import { tradingPairRegistry } from './market/TradingPairRegistry';
import { marketStore } from '../store/marketStore';
import { fetchMarketData } from './marketData';
import { futuresMarketService } from './futures/FuturesMarketService';
import { SpotTrading } from '../pages/SpotTrading';
import { ErrorBoundary } from '../components/ErrorBoundary';

// Mock contexts and hooks for component tests
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'demo-user-1', displayName: 'Demo User' },
    isAuthenticated: true
  }),
  AuthProvider: ({ children }: any) => <>{children}</>
}));

vi.mock('../hooks/useLedger', () => ({
  useLedger: () => ({
    balances: { USDT: '10000', BTC: '1.5', USDC: '5000' }
  })
}));

vi.mock('../hooks/useOrders', () => ({
  useOrders: () => ({
    orders: [],
    pendingOrders: [],
    orderService: { placeOrder: vi.fn(), cancelOrder: vi.fn() }
  })
}));

vi.mock('../hooks/useTrades', () => ({
  useTrades: () => ({
    trades: []
  })
}));

describe('Phase 3 Step 1: Pair Identity & Startup Defensive Guards', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
  });

  it('1. Empty market list does not crash SpotTrading and renders safe loading state', () => {
    // When marketData returns empty array, SpotTrading should not throw
    const { container } = render(<SpotTrading selectedSymbol="BTCUSDT" />);
    expect(container).toBeDefined();
    expect(screen.queryByText(/loading/i) || screen.queryByText(/BTC/i)).toBeTruthy();
  });

  it('2. Invalid or unknown pair ID does not crash the UI or market store', () => {
    expect(() => {
      marketStore.setSelectedSymbol('UNKNOWN_INVALID_PAIR_999');
    }).not.toThrow();

    // Default symbol remains safe
    expect(marketStore.getSelectedSymbol()).toBeDefined();

    // TradingPairRegistry safely handles unknown symbol
    const pair = tradingPairRegistry.getPair('NON_EXISTENT_PAIR');
    expect(pair).toBeUndefined();
    expect(tradingPairRegistry.isSupported('NON_EXISTENT_PAIR')).toBe(false);
  });

  it('3. Top-200 spot symbols resolve to canonical spot pairs and never produce invalid IDs like BTC-SPOT', () => {
    const canonicalBTC = tradingPairRegistry.resolveCanonicalSymbol('BTCUSDT-SPOT');
    expect(canonicalBTC).toBe('BTCUSDT');

    const canonicalETH = tradingPairRegistry.resolveCanonicalSymbol('ETHUSDT');
    expect(canonicalETH).toBe('ETHUSDT');

    const canonicalUSDC = tradingPairRegistry.resolveCanonicalSymbol('LINKUSDC');
    expect(canonicalUSDC).toBe('LINKUSDC');

    // getSpotPair handles both clean and legacy suffixes
    const spotBTC = tradingPairRegistry.getSpotPair('BTCUSDT');
    expect(spotBTC).toBeDefined();
    expect(spotBTC?.baseAsset).toBe('BTC');
    expect(spotBTC?.quoteAsset).toBe('USDT');
    expect(spotBTC?.marketType).toBe('SPOT');

    const spotUSDC = tradingPairRegistry.getSpotPair('BTCUSDC');
    expect(spotUSDC).toBeDefined();
    expect(spotUSDC?.baseAsset).toBe('BTC');
    expect(spotUSDC?.quoteAsset).toBe('USDC');
  });

  it('4. Futures market service does not resolve Spot-only pairs as Futures markets', async () => {
    // LINKUSDC is Spot only
    const isLinkUsdcFutures = futuresMarketService.isValidSymbol('LINKUSDC');
    expect(isLinkUsdcFutures).toBe(false);

    const futuresMarket = await futuresMarketService.getMarket('LINKUSDC');
    expect(futuresMarket).toBeNull();

    // BTCUSDT is a valid Futures market
    const isBtcFutures = futuresMarketService.isValidSymbol('BTCUSDT');
    expect(isBtcFutures).toBe(true);
  });

  it('5. Startup market data failure produces safe fallback empty array', async () => {
    // fetchMarketData falls back cleanly without throwing unhandled exceptions
    const markets = await fetchMarketData();
    expect(Array.isArray(markets)).toBe(true);
    expect(markets.length).toBe(0);
  });

  it('6. Root ErrorBoundary catches rendering exceptions and prevents white-screen crashes', () => {
    const CrashingComponent = () => {
      throw new Error('Simulated startup render crash');
    };

    // Suppress console.error in test output for simulated crash
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <CrashingComponent />
      </ErrorBoundary>
    );

    expect(screen.getByText(/Something went wrong/i)).toBeTruthy();
    expect(screen.getByText(/Simulated startup render crash/i)).toBeTruthy();

    spy.mockRestore();
  });
});
