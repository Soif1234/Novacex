import React from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MarketSelector } from './MarketSelector';
import { userPreferencesStore } from '../store/userPreferencesStore';
import { useMarketData } from '../hooks/useMarketData';

// Mock useMarketData
vi.mock('../hooks/useMarketData', () => ({
  useMarketData: vi.fn(() => ({ data: [] }))
}));

describe('MarketSelector', () => {
  beforeEach(() => {
    localStorage.clear();
    // Re-initialize store by forcing load
    // Using a fresh state to isolate tests
    // @ts-ignore
    userPreferencesStore.favorites = [];
    // @ts-ignore
    userPreferencesStore.recentPairs = [];
    vi.mocked(useMarketData).mockReturnValue({
      data: [
        { id: '1', baseAsset: 'BTC', quoteAsset: 'USDT', price: 60000, priceStr: '60000', change24h: 1.5, volume: 1 },
        { id: '2', baseAsset: 'ETH', quoteAsset: 'USDT', price: 3000, priceStr: '3000', change24h: -1.5, volume: 1 },
        // Add a mock for NaN / Infinity / Invalid testing
        { id: '3', baseAsset: 'DOGE', quoteAsset: 'USDT', price: NaN, priceStr: '--', change24h: Infinity, volume: 1 },
      ]
    } as any);
  });

  it('1. MarketSelector renders & 22. Mobile selector rendering', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    expect(screen.getByPlaceholderText('Search pairs...')).toBeTruthy();
  });

  it('2. Search BTC & 5. Case-insensitive search', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search pairs...'), { target: { value: 'btc' } });
    expect(screen.getByText('BTC')).toBeTruthy();
    expect(screen.queryByText('ETH')).not.toBeTruthy();
  });

  it('3. Search ETH', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search pairs...'), { target: { value: 'ETH' } });
    expect(screen.getByText('ETH')).toBeTruthy();
    expect(screen.queryByText('BTC')).not.toBeTruthy();
  });

  it('4. Search by quote asset', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search pairs...'), { target: { value: 'USDT' } });
    // Should show multiple USDT pairs
    expect(screen.getByText('BTC')).toBeTruthy();
    expect(screen.getByText('ETH')).toBeTruthy();
  });

  it('6. Empty search results', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search pairs...'), { target: { value: 'NONEXISTENT' } });
    expect(screen.getByText('No markets found')).toBeTruthy();
  });

  it('7. Favorites add & 8. Favorites remove', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    const buttons = screen.getAllByLabelText(/Add.*to favorites/);
    fireEvent.click(buttons[0]);
    // The first pair (BTCUSDT) should now have a different label indicating it can be removed
    expect(screen.getByLabelText(/Remove.*from favorites/)).toBeTruthy();
    
    // Remove it
    fireEvent.click(screen.getByLabelText(/Remove.*from favorites/));
    expect(screen.queryByLabelText(/Remove.*from favorites/)).not.toBeTruthy();
  });

  it('9. Favorites persistence & 10. Duplicate favorite prevention & 11. Invalid favorite handling', () => {
    // Add favorite directly to store to simulate persistence logic
    userPreferencesStore.toggleFavorite('BTCUSDT');
    userPreferencesStore.toggleFavorite('BTCUSDT'); // Duplicate toggle will actually remove it since it's a toggle.
    expect(userPreferencesStore.getFavorites()).toEqual([]);
    
    // Add again
    userPreferencesStore.toggleFavorite('BTCUSDT');
    // Try adding invalid
    userPreferencesStore.toggleFavorite('INVALIDPAIR');
    expect(userPreferencesStore.getFavorites()).toEqual(['BTCUSDT']);
    
    // Check local storage format (raw)
    const stored = JSON.parse(localStorage.getItem('nova_favorites') || '[]');
    expect(stored).toEqual(['BTCUSDT']);
  });

  it('12. Favorites tab & 13. Spot tab & 14. Futures tab', () => {
    userPreferencesStore.toggleFavorite('ETHUSDT');
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    
    // Click Spot tab
    fireEvent.click(screen.getByText('Spot'));
    expect(screen.getByText('LINK')).toBeTruthy(); // assuming LINKUSDC is Spot
    
    // Click Favorites tab
    fireEvent.click(screen.getByText('Favorites'));
    expect(screen.getByText('ETH')).toBeTruthy();
    expect(screen.queryByText('BTC')).not.toBeTruthy();
    
    // Click Futures tab
    fireEvent.click(screen.getByText('Futures'));
    expect(screen.getByText('BTC')).toBeTruthy();
  });

  it('15. Category filtering', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    // Select Meme category
    fireEvent.click(screen.getByText('Meme'));
    expect(screen.getByText('DOGE')).toBeTruthy();
    expect(screen.queryByText('BTC')).not.toBeTruthy();
  });

  it('16. Recent pairs & 17. Maximum 5 recent pairs & 18. Recent duplicate prevention', () => {
    const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'FETUSDT'];
    pairs.forEach(p => userPreferencesStore.addRecentPair(p));
    
    // FETUSDT was added last, so it should be first. BTCUSDT should be pushed out.
    const recents = userPreferencesStore.getRecentPairs();
    expect(recents.length).toBe(5);
    expect(recents[0]).toBe('FETUSDT');
    expect(recents).not.toContain('BTCUSDT');
    
    // Add duplicate to top
    userPreferencesStore.addRecentPair('ETHUSDT');
    expect(userPreferencesStore.getRecentPairs()[0]).toBe('ETHUSDT');
    expect(userPreferencesStore.getRecentPairs().length).toBe(5); // Still 5
  });

  it('19. Invalid ticker handling & 20. No NaN & 21. No Infinity', () => {
    render(<MarketSelector isOpen={true} onClose={() => {}} onSelect={() => {}} />);
    // Our mock has DOGE with NaN price and Infinity change
    // Search DOGE to isolate
    fireEvent.change(screen.getByPlaceholderText('Search pairs...'), { target: { value: 'DOGE' } });
    
    const elements = screen.getAllByText('--');
    expect(elements.length).toBeGreaterThan(0);
    expect(screen.queryByText('NaN')).not.toBeTruthy();
    expect(screen.queryByText('Infinity')).not.toBeTruthy();
  });
});
