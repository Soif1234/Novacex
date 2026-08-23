import { describe, it, expect } from 'vitest';
import { OrderBookService } from './OrderBookService';

describe.skip('OrderBookService', () => {
  it('should generate deterministic order book data', () => {
    const book1 = OrderBookService.generateSimulatedBook('BTCUSDT', 60000, 5, 0.001);
    const book2 = OrderBookService.generateSimulatedBook('BTCUSDT', 60000, 5, 0.001);
    
    expect(book1).toEqual(book2);
    
    // Changing price should change the book slightly
    const book3 = OrderBookService.generateSimulatedBook('BTCUSDT', 60100, 5, 0.001);
    expect(book1).not.toEqual(book3);
  });

  it('should generate correct depth and spacing', () => {
    const depth = 8;
    const price = 1000;
    const step = 0.01; // 1%
    const book = OrderBookService.generateSimulatedBook('ETHUSDT', price, depth, step);
    
    expect(book.asks).toHaveLength(depth);
    expect(book.bids).toHaveLength(depth);
    
    // Asks should be sorted descending
    for (let i = 0; i < depth - 1; i++) {
      expect(book.asks[i].price).toBeGreaterThan(book.asks[i+1].price);
    }
    
    // Bids should be sorted descending
    for (let i = 0; i < depth - 1; i++) {
      expect(book.bids[i].price).toBeGreaterThan(book.bids[i+1].price);
    }
    
    // Lowest ask should be > price
    expect(book.asks[book.asks.length - 1].price).toBeGreaterThan(price);
    
    // Highest bid should be < price
    expect(book.bids[0].price).toBeLessThan(price);
  });

  it('should calculate accumulated totals correctly', () => {
    const book = OrderBookService.generateSimulatedBook('DOGEUSDT', 0.1, 3, 0.01);
    
    // Bids: index 0 is closest to price, accumulates downwards
    expect(book.bids[0].total).toBe(book.bids[0].quantity);
    expect(book.bids[1].total).toBe(book.bids[0].quantity + book.bids[1].quantity);
    expect(book.bids[2].total).toBe(book.bids[0].quantity + book.bids[1].quantity + book.bids[2].quantity);

    // Asks: index last is closest to price, accumulates upwards
    expect(book.asks[2].total).toBe(book.asks[2].quantity);
    expect(book.asks[1].total).toBe(book.asks[2].quantity + book.asks[1].quantity);
    expect(book.asks[0].total).toBe(book.asks[2].quantity + book.asks[1].quantity + book.asks[0].quantity);
  });
});
