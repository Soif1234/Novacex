export interface OrderBookEntry {
  price: number;
  quantity: number;
  total: number;
}

export interface OrderBook {
  asks: OrderBookEntry[];
  bids: OrderBookEntry[];
}

/**
 * Simple deterministic pseudo-random number generator
 * based on a seed. Returns a value between 0 and 1.
 */
function seededRandom(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

export class OrderBookService {
  /**
   * Generates a deterministic simulated order book based on the symbol and current price.
   */
  public static generateSimulatedBook(
    symbol: string,
    currentPrice: number,
    depth: number = 8,
    priceStepPct: number = 0.0005
  ): OrderBook {
    const asks: OrderBookEntry[] = [];
    const bids: OrderBookEntry[] = [];

    // Create a base seed from the symbol to ensure consistent random distributions
    let baseSeed = 0;
    for (let i = 0; i < symbol.length; i++) {
      baseSeed += symbol.charCodeAt(i);
    }

    // Determine an appropriate base quantity so it looks realistic
    // For example, target around $20,000 USD per level on average
    const targetValueUsd = 20000;
    const baseQuantity = targetValueUsd / currentPrice;

    // Generate Asks (Sell orders: price > current)
    for (let i = 1; i <= depth; i++) {
      const askPrice = currentPrice * (1 + (i * priceStepPct));
      const askSeed = baseSeed + i * 100 + Math.floor(askPrice * 10000);
      
      // Multiplier between 0.1x and 2.0x
      const qtyMultiplier = 0.1 + seededRandom(askSeed) * 1.9;
      const quantity = baseQuantity * qtyMultiplier;

      asks.push({ price: askPrice, quantity, total: 0 });
    }

    // Generate Bids (Buy orders: price < current)
    for (let i = 1; i <= depth; i++) {
      const bidPrice = currentPrice * (1 - (i * priceStepPct));
      const bidSeed = baseSeed + i * 200 + Math.floor(bidPrice * 10000);
      
      const qtyMultiplier = 0.1 + seededRandom(bidSeed) * 1.9;
      const quantity = baseQuantity * qtyMultiplier;

      bids.push({ price: bidPrice, quantity, total: 0 });
    }

    // Sort Asks descending (highest at index 0, lowest at the end closest to center)
    asks.sort((a, b) => b.price - a.price);
    
    // Sort Bids descending (highest at index 0 closest to center, lowest at the end)
    bids.sort((a, b) => b.price - a.price);

    // Calculate accumulating totals
    // For asks, it accumulates from the bottom (closest to spread) up to the top
    let currentAskTotal = 0;
    for (let i = asks.length - 1; i >= 0; i--) {
      currentAskTotal += asks[i].quantity;
      asks[i].total = currentAskTotal;
    }

    // For bids, it accumulates from the top (closest to spread) down to the bottom
    let currentBidTotal = 0;
    for (let i = 0; i < bids.length; i++) {
      currentBidTotal += bids[i].quantity;
      bids[i].total = currentBidTotal;
    }

    return { asks, bids };
  }
}
