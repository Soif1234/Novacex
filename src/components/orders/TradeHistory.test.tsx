import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { TradeHistory } from './TradeHistory';
import { AuthProvider } from '../../contexts/AuthContext';
import { tradeFillService } from '../../services/orders/TradeFillService';
import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'test-user-1', name: 'Test User' },
    login: vi.fn(),
    logout: vi.fn(),
    register: vi.fn()
  }),
  AuthProvider: ({ children }: any) => <div>{children}</div>
}));

vi.mock('../../services/orders/TradeFillService', () => {
  return {
    tradeFillService: {
      getTradeHistory: vi.fn(),
      subscribe: vi.fn(() => vi.fn())
    }
  };
});

describe('TradeHistory', () => {
  beforeEach(() => {
    vi.mocked(tradeFillService.getTradeHistory).mockReturnValue([
      {
        id: 'trade-1',
        orderId: 'order-1',
        symbol: 'BTC/USDT',
        market: 'SPOT',
        side: 'BUY',
        price: '60000',
        quantity: '1',
        fee: '60',
        feeAsset: 'USDT',
        createdAt: Date.now() - 1000
      }
    ]);
  });

  it('renders trade history correctly', () => {
    render(
      <AuthProvider>
        <TradeHistory />
      </AuthProvider>
    );
    expect(screen.getByText('BTC/USDT')).toBeInTheDocument();
    expect(screen.getByText('60000')).toBeInTheDocument();
  });
});
