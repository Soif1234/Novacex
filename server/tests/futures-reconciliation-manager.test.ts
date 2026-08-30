import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FuturesReconciliationManager } from '../src/services/liquidity/futures-reconciliation.manager';
import { Pool } from 'pg';

const mockAdapter = {
  getClearinghouseState: vi.fn(),
  getOpenOrders: vi.fn(),
  client: { getOpenOrders: vi.fn() }
} as any;

const mockQuery = vi.fn();
const mockConnect = vi.fn().mockResolvedValue({
  query: mockQuery,
  release: vi.fn()
});

const mockDb = {
  connect: mockConnect
} as unknown as Pool;

describe('FuturesReconciliationManager', () => {
  let manager: FuturesReconciliationManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new FuturesReconciliationManager(mockDb, mockAdapter);
  });

  it('should detect DRIFT_DETECTED when actual differs from expected', async () => {
    // Expected = 5 (from DB)
    mockQuery.mockResolvedValueOnce({
      rows: [{ market: 'BTC-USD', expected_position: '5.0' }]
    });

    // Actual = 3.0 (from Venue)
    mockAdapter.getClearinghouseState.mockResolvedValueOnce({
      assetPositions: [
        { position: { coin: 'BTC-USD', szi: '3.0' } }
      ]
    });

    // Mock the begin/commit/rollback
    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({ rowCount: 0 }) // check unresolved event
      .mockResolvedValueOnce({}) // insert event
      .mockResolvedValueOnce({}) // update venue_positions
      .mockResolvedValueOnce({}); // COMMIT

    const results = await manager.reconcilePositions();

    expect(results).toHaveLength(1);
    expect(results[0]).toEqual({
      status: 'DRIFT_DETECTED',
      market: 'BTC-USD',
      expected: '5.0',
      actual: '3.0',
      delta: '-2.0'
    });
  });

  it('should evaluate HEALTHY when expected matches actual', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ market: 'ETH-USD', expected_position: '-10.5' }]
    });

    mockAdapter.getClearinghouseState.mockResolvedValueOnce({
      assetPositions: [
        { position: { coin: 'ETH-USD', szi: '-10.5' } }
      ]
    });

    mockQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({}) // update venue_positions
      .mockResolvedValueOnce({}); // COMMIT

    const results = await manager.reconcilePositions();

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('HEALTHY');
    expect(results[0].delta).toBe('0');
  });

  it('should identify ORDER_MISSING_EXTERNALLY', async () => {
    // Expected Open Order
    mockQuery.mockResolvedValueOnce({
      rows: [{ cloid: '0x123', venue_order_id: '999', market: 'BTC-USD', side: 'BUY', remaining_quantity: '1.0' }]
    });

    // Actual Open Orders (Empty)
    mockAdapter.getOpenOrders.mockResolvedValueOnce([]);

    // Insert reconciliation event
    mockQuery.mockResolvedValueOnce({});

    await manager.reconcileOpenOrders();

    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO hedge_reconciliation_events"),
      expect.arrayContaining(['BTC-USD', expect.stringContaining('ORDER_MISSING_EXTERNALLY')])
    );
  });
});
