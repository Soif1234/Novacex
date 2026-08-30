import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FuturesHedgeManager } from '../src/services/liquidity/futures-hedge.manager';
import { HyperliquidAdapter } from '../src/services/liquidity/hyperliquid/hyperliquid.adapter';
import { IExposureGuard } from '../src/domain/liquidity/exposure-guard.interface';
import { Pool } from 'pg';

describe('FuturesHedgeManager (Durable DB)', () => {
  let manager: FuturesHedgeManager;
  let mockAdapter: any;
  let mockGuard: any;
  let mockPool: any;
  let mockClient: any;

  beforeEach(() => {
    mockAdapter = {
      placeHedgeOrder: vi.fn(),
      recoverUnknownOrder: vi.fn()
    };

    mockGuard = {
      evaluateHedge: vi.fn().mockReturnValue({ result: 'ALLOW', reason: 'ok' })
    };

    mockClient = {
      query: vi.fn().mockImplementation((q: string, values: any[]) => {
        if (q.includes('house_exposure_events')) return { rowCount: 0 };
        if (q.includes('SELECT signed_exposure')) return { rowCount: 1, rows: [{ signed_exposure: '-1', version: '1' }] };
        if (q.includes('hedge_intents WHERE status = \'UNKNOWN_PENDING_RECONCILIATION\'')) {
          return { rows: [{ hedge_intent_id: '1', created_at: new Date() }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn()
    };

    mockPool = {
      connect: vi.fn().mockResolvedValue(mockClient)
    };

    manager = new FuturesHedgeManager(
      mockAdapter as unknown as HyperliquidAdapter,
      mockGuard as unknown as IExposureGuard,
      mockPool as unknown as Pool
    );
  });

  it('should process customer fills transactionally', async () => {
    await manager.processCustomerFill('BTC-PERP', 'BUY', '1', '60000', 'trade_123');

    // Check that DB transaction was used
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO house_exposure_events'), ['trade_123', 'BTC-PERP', 'BUY', '1']);
    expect(mockClient.query).toHaveBeenCalledWith('COMMIT');
  });

  it('should ignore duplicate customer fills via event_id', async () => {
    // Mock event check returning 1 row (already processed)
    mockClient.query.mockImplementation((q: string) => {
      if (q.includes('house_exposure_events WHERE event_id')) return { rowCount: 1 };
      return { rowCount: 0, rows: [] };
    });

    await manager.processCustomerFill('BTC-PERP', 'BUY', '1', '60000', 'trade_123');
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('should recover state on initialization', async () => {
    await manager.initializeAndRecover();
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM hedge_intents'));
  });

  it('should persist hedge intents to DB', async () => {
    mockAdapter.placeHedgeOrder.mockResolvedValue({ status: 'OPEN', venueOrderId: 'ext123', remainingQuantity: '1' });
    await manager.initializeAndRecover();
    const intent = await manager.createHedgeIntent('BTC-PERP', 'BUY', '1', 'INTERNAL_NET_EXPOSURE', '0');

    // Initial insert
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO hedge_intents'), expect.any(Array));
    // Status update
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE hedge_intents SET status = $1'), ['OPEN', 'ext123', '1', intent.hedgeIntentId]);
    // External order persistence
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO external_orders'), expect.any(Array));
  });
});
