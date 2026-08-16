import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Markets } from './Markets';
import { tickerService } from '../services/market/TickerService';

vi.mock('../hooks/useTicker', () => ({
  useTicker: () => tickerService.getAllTickers()
}));

describe('Markets Page', () => {
  beforeEach(() => {
    // @ts-ignore
    tickerService.tickers.clear();
    
    // @ts-ignore
    tickerService.updateTickerFromRest({
      symbol: 'BTCUSDT',
      lastPrice: '60000',
      priceChangePercent: '5.0',
      quoteVolume: '100000',
      highPrice: '61000',
      lowPrice: '59000'
    });
    
    // @ts-ignore
    tickerService.updateTickerFromRest({
      symbol: 'ETHUSDT',
      lastPrice: '3000',
      priceChangePercent: '-2.0',
      quoteVolume: '50000',
      highPrice: '3100',
      lowPrice: '2900'
    });
    
    // @ts-ignore
    tickerService.updateTickerFromRest({
      symbol: 'SOLUSDT',
      lastPrice: '100',
      priceChangePercent: '10.0',
      quoteVolume: '20000',
      highPrice: '105',
      lowPrice: '95'
    });
  });

  it('9. gainers sorting & 10. losers sorting', () => {
    const { getByText } = render(<Markets onNavigate={vi.fn()} />);
    
    // Click Gainers
    fireEvent.click(getByText('Gainers'));
    let rows = document.querySelectorAll('.cursor-pointer');
    // In gainers: SOL (10%), BTC (5%), ETH (-2%)
    expect(rows[0].textContent).toContain('SOL');
    expect(rows[1].textContent).toContain('BTC');
    expect(rows[2].textContent).toContain('ETH');
    
    // Click Losers
    fireEvent.click(getByText('Losers'));
    rows = document.querySelectorAll('.cursor-pointer');
    expect(rows[0].textContent).toContain('ETH');
    expect(rows[1].textContent).toContain('BTC');
    expect(rows[2].textContent).toContain('SOL');
  });

  it('11. volume sorting & 12. price sorting', () => {
    const { getByText } = render(<Markets onNavigate={vi.fn()} />);
    
    fireEvent.click(screen.getAllByText('Volume')[1] || screen.getAllByText('Volume')[0]);
    let rows = document.querySelectorAll('.cursor-pointer');
    // BTC (100k), ETH (50k), SOL (20k)
    expect(rows[0].textContent).toContain('BTC');
    expect(rows[1].textContent).toContain('ETH');
    expect(rows[2].textContent).toContain('SOL');
    
    fireEvent.click(screen.getAllByText('Price')[1] || screen.getAllByText('Price')[0]);
    rows = document.querySelectorAll('.cursor-pointer');
    // BTC (60k), ETH (3k), SOL (100)
    expect(rows[0].textContent).toContain('BTC');
    expect(rows[1].textContent).toContain('ETH');
    expect(rows[2].textContent).toContain('SOL');
  });

  it('20. NaN prevention & 21. Infinity prevention', () => {
    // Add corrupted ticker
    // @ts-ignore
    tickerService.updateTickerFromRest({
      symbol: 'DOGEUSDT',
      lastPrice: 'NaN',
      priceChangePercent: 'Infinity',
      quoteVolume: 'undefined'
    });
    
    render(<Markets onNavigate={vi.fn()} />);
    // Should not crash, should render
    expect(screen.getByText('DOGE')).toBeDefined();
    // It will render -- or some fallback, just verifying it renders without crashing
  });
});
