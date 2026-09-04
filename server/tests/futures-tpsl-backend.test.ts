import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FuturesTpSlService, ActiveTpSlCandidate } from '../src/services/futures/tpsl.service';
import { TpSlWorker } from '../src/workers/TpSlWorker';
import { IDatabaseConnection } from '../src/config/database';
import { FuturesService } from '../src/services/futures/futures.service';
import { MarketDataService } from '../src/services/market/market.service';
import { CircuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { NoPositionToCloseError } from '../src/services/futures/errors';

describe('Phase 15B.2: Backend-Authoritative TP/SL Trigger & Execution', () => {
  let mockDb: IDatabaseConnection;
  let mockFuturesService: FuturesService;
  let mockMarketService: MarketDataService;
  let mockBreakerService: CircuitBreakerService;
  let tpslService: FuturesTpSlService;
  let worker: TpSlWorker;

  const mockConfigId = 'config-uuid-1111';
  const mockPositionId = 'pos-uuid-2222';
  const mockAccountId = 'acc-uuid-3333';
  const mockOrderId = 'order-uuid-4444';

  beforeEach(() => {
    vi.resetAllMocks();

    mockDb = {
      connect: vi.fn(),
      close: vi.fn(),
      query: vi.fn(),
      transaction: vi.fn(),
      healthCheck: vi.fn(),
      getStatus: vi.fn(),
    } as unknown as IDatabaseConnection;

    mockFuturesService = {
      placeOrder: vi.fn(),
    } as unknown as FuturesService;

    mockMarketService = {
      getMarkPrice: vi.fn(),
    } as unknown as MarketDataService;

    mockBreakerService = {
      isSubsystemOperational: vi.fn().mockResolvedValue({ operational: true, mode: 'ACTIVE' }),
    } as unknown as CircuitBreakerService;

    tpslService = new FuturesTpSlService(mockDb, mockFuturesService, mockMarketService);
    worker = new TpSlWorker(2000, tpslService, mockBreakerService);
  });

  afterEach(() => {
    worker.stop();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Scenario A: LONG TP trigger
  // ==========================================================================
  it('Scenario A: LONG position triggers TP when markPrice >= takeProfitPrice', async () => {
    // Config: LONG, TP at 65000, SL at 55000. Mark price: 65500
    const candidateRow = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfitEnabled: true,
      takeProfitPrice: '65000',
      stopLossEnabled: true,
      stopLossPrice: '55000',
      quantity: '1.5',
      leverage: 10,
      marginMode: 'ISOLATED',
      positionStatus: 'OPEN',
    };

    // Candidates query returns candidate
    (mockDb.query as any).mockImplementation((sql: string, params?: any[]) => {
      if (sql.includes('FROM futures_tpsl_configs c')) {
        return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
      }
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({
          rows: [{ id: mockPositionId, quantity: '1.5', leverage: 10, marginMode: 'ISOLATED', status: 'OPEN' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockResolvedValue({
      order: { id: mockOrderId, status: 'FILLED' },
    });

    const results = await tpslService.checkAllActiveTriggers({ BTCUSDT: '65500' });

    expect(results).toHaveLength(1);
    expect(results[0].triggerType).toBe('TP');
    expect(results[0].status).toBe('EXECUTED');
    expect(results[0].observedMarkPrice).toBe('65500');
    expect(results[0].orderId).toBe(mockOrderId);

    // Verified: LONG position closed with SELL market order
    expect(mockFuturesService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: mockAccountId,
        symbol: 'BTCUSDT',
        side: 'SELL',
        positionSide: 'LONG',
        type: 'MARKET',
        quantity: '1.5',
        reduceOnly: true,
        closePosition: true,
      })
    );
  });

  // ==========================================================================
  // Scenario B: LONG SL trigger
  // ==========================================================================
  it('Scenario B: LONG position triggers SL when markPrice <= stopLossPrice', async () => {
    const candidateRow = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfitEnabled: true,
      takeProfitPrice: '65000',
      stopLossEnabled: true,
      stopLossPrice: '55000',
      quantity: '2.0',
      leverage: 5,
      marginMode: 'CROSS',
      positionStatus: 'OPEN',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM futures_tpsl_configs c')) {
        return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
      }
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({
          rows: [{ id: mockPositionId, quantity: '2.0', leverage: 5, marginMode: 'CROSS', status: 'OPEN' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockResolvedValue({
      order: { id: mockOrderId, status: 'FILLED' },
    });

    const results = await tpslService.checkAllActiveTriggers({ BTCUSDT: '54000' });

    expect(results).toHaveLength(1);
    expect(results[0].triggerType).toBe('SL');
    expect(results[0].status).toBe('EXECUTED');
    expect(mockFuturesService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'SELL',
        positionSide: 'LONG',
        quantity: '2.0',
        closePosition: true,
      })
    );
  });

  // ==========================================================================
  // Scenario C: SHORT TP trigger
  // ==========================================================================
  it('Scenario C: SHORT position triggers TP when markPrice <= takeProfitPrice', async () => {
    const candidateRow = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      symbol: 'ETHUSDT',
      positionSide: 'SHORT',
      takeProfitEnabled: true,
      takeProfitPrice: '3000',
      stopLossEnabled: true,
      stopLossPrice: '3500',
      quantity: '10.0',
      leverage: 20,
      marginMode: 'ISOLATED',
      positionStatus: 'OPEN',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM futures_tpsl_configs c')) {
        return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
      }
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({
          rows: [{ id: mockPositionId, quantity: '10.0', leverage: 20, marginMode: 'ISOLATED', status: 'OPEN' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockResolvedValue({
      order: { id: mockOrderId, status: 'FILLED' },
    });

    // Mark price drops to 2950 (below 3000 TP)
    const results = await tpslService.checkAllActiveTriggers({ ETHUSDT: '2950' });

    expect(results).toHaveLength(1);
    expect(results[0].triggerType).toBe('TP');
    expect(results[0].status).toBe('EXECUTED');
    // SHORT position closed with BUY market order
    expect(mockFuturesService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'BUY',
        positionSide: 'SHORT',
        quantity: '10.0',
        closePosition: true,
      })
    );
  });

  // ==========================================================================
  // Scenario D: SHORT SL trigger
  // ==========================================================================
  it('Scenario D: SHORT position triggers SL when markPrice >= stopLossPrice', async () => {
    const candidateRow = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      symbol: 'ETHUSDT',
      positionSide: 'SHORT',
      takeProfitEnabled: true,
      takeProfitPrice: '3000',
      stopLossEnabled: true,
      stopLossPrice: '3500',
      quantity: '5.0',
      leverage: 10,
      marginMode: 'ISOLATED',
      positionStatus: 'OPEN',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM futures_tpsl_configs c')) {
        return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
      }
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({
          rows: [{ id: mockPositionId, quantity: '5.0', leverage: 10, marginMode: 'ISOLATED', status: 'OPEN' }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockResolvedValue({
      order: { id: mockOrderId, status: 'FILLED' },
    });

    // Mark price rises to 3550 (above 3500 SL)
    const results = await tpslService.checkAllActiveTriggers({ ETHUSDT: '3550' });

    expect(results).toHaveLength(1);
    expect(results[0].triggerType).toBe('SL');
    expect(results[0].status).toBe('EXECUTED');
    expect(mockFuturesService.placeOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'BUY',
        positionSide: 'SHORT',
        quantity: '5.0',
        closePosition: true,
      })
    );
  });

  // ==========================================================================
  // Scenario E: No trigger before threshold
  // ==========================================================================
  it('Scenario E: no trigger occurs when price is strictly within bounds', async () => {
    const candidateRow = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfitEnabled: true,
      takeProfitPrice: '65000',
      stopLossEnabled: true,
      stopLossPrice: '55000',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
      positionStatus: 'OPEN',
    };

    (mockDb.query as any).mockResolvedValue({ rows: [candidateRow], rowCount: 1 });

    // Mark price 60000 (between 55000 and 65000)
    const results = await tpslService.checkAllActiveTriggers({ BTCUSDT: '60000' });

    expect(results).toHaveLength(0);
    expect(mockFuturesService.placeOrder).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario F: Exact threshold behavior
  // ==========================================================================
  describe('Scenario F: Exact boundary threshold behavior', () => {
    it('LONG TP triggers at EXACT takeProfitPrice', async () => {
      const candidateRow = {
        id: mockConfigId,
        positionId: mockPositionId,
        accountId: mockAccountId,
        symbol: 'BTCUSDT',
        positionSide: 'LONG',
        takeProfitEnabled: true,
        takeProfitPrice: '65000',
        quantity: '1.0',
        leverage: 10,
        marginMode: 'ISOLATED',
        positionStatus: 'OPEN',
      };

      (mockDb.query as any).mockImplementation((sql: string) => {
        if (sql.includes('FROM futures_tpsl_configs c')) return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
        if (sql.includes('UPDATE futures_tpsl_configs')) return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
        if (sql.includes('FROM futures_positions')) return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '1.0', status: 'OPEN' }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      (mockFuturesService.placeOrder as any).mockResolvedValue({ order: { id: mockOrderId } });

      const results = await tpslService.checkAllActiveTriggers({ BTCUSDT: '65000' });
      expect(results).toHaveLength(1);
      expect(results[0].triggerType).toBe('TP');
    });

    it('LONG SL triggers at EXACT stopLossPrice', async () => {
      const candidateRow = {
        id: mockConfigId,
        positionId: mockPositionId,
        accountId: mockAccountId,
        symbol: 'BTCUSDT',
        positionSide: 'LONG',
        stopLossEnabled: true,
        stopLossPrice: '55000',
        quantity: '1.0',
        leverage: 10,
        marginMode: 'ISOLATED',
        positionStatus: 'OPEN',
      };

      (mockDb.query as any).mockImplementation((sql: string) => {
        if (sql.includes('FROM futures_tpsl_configs c')) return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
        if (sql.includes('UPDATE futures_tpsl_configs')) return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
        if (sql.includes('FROM futures_positions')) return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '1.0', status: 'OPEN' }], rowCount: 1 });
        return Promise.resolve({ rows: [], rowCount: 0 });
      });
      (mockFuturesService.placeOrder as any).mockResolvedValue({ order: { id: mockOrderId } });

      const results = await tpslService.checkAllActiveTriggers({ BTCUSDT: '55000' });
      expect(results).toHaveLength(1);
      expect(results[0].triggerType).toBe('SL');
    });
  });

  // ==========================================================================
  // Scenario G: Browser closed / no frontend
  // ==========================================================================
  it('Scenario G: autonomous worker sweep executes independently of any browser/client session', async () => {
    (mockMarketService.getMarkPrice as any).mockResolvedValue({ price: '70000' });

    const candidateRow = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      takeProfitEnabled: true,
      takeProfitPrice: '65000',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
      positionStatus: 'OPEN',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM futures_tpsl_configs c')) return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
      if (sql.includes('UPDATE futures_tpsl_configs')) return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      if (sql.includes('FROM futures_positions')) return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '1.0', status: 'OPEN' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    (mockFuturesService.placeOrder as any).mockResolvedValue({ order: { id: mockOrderId } });

    worker.isRunning = true;
    await worker.pollAndTrigger();

    expect(mockMarketService.getMarkPrice).toHaveBeenCalledWith('BTCUSDT');
    expect(mockFuturesService.placeOrder).toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario H & I: Concurrent trigger evaluation / duplicate worker evaluation
  // ==========================================================================
  it('Scenario H & I: concurrent triggers result in AT MOST ONE execution (atomic DB claim)', async () => {
    const candidate: ActiveTpSlCandidate = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      userId: 'user-uuid-mock',
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
    };

    let claimCount = 0;
    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        claimCount++;
        if (claimCount === 1) {
          // First caller wins atomic claim
          return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
        } else {
          // Parallel caller gets 0 rows (already claimed)
          return Promise.resolve({ rows: [], rowCount: 0 });
        }
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '1.0', status: 'OPEN' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockResolvedValue({ order: { id: mockOrderId } });

    // Execute concurrently
    const [res1, res2] = await Promise.all([
      tpslService.executeTrigger(candidate, 'TP', '65000', '65500'),
      tpslService.executeTrigger(candidate, 'TP', '65000', '65500'),
    ]);

    expect(res1).not.toBeNull();
    expect(res1?.status).toBe('EXECUTED');
    expect(res2).toBeNull(); // Second parallel call was rejected by database claim
    expect(mockFuturesService.placeOrder).toHaveBeenCalledTimes(1);
  });

  // ==========================================================================
  // Scenario J: Restart recovery
  // ==========================================================================
  it('Scenario J: restart recovery re-reads active configs from PostgreSQL and triggers', async () => {
    // Fresh service instance simulates process reboot
    const rebootedService = new FuturesTpSlService(mockDb, mockFuturesService, mockMarketService);

    const candidateRow = {
      id: 'reboot-config-1',
      positionId: 'reboot-pos-1',
      accountId: mockAccountId,
      symbol: 'SOLUSDT',
      positionSide: 'LONG',
      takeProfitEnabled: true,
      takeProfitPrice: '200',
      quantity: '10.0',
      leverage: 5,
      marginMode: 'ISOLATED',
      positionStatus: 'OPEN',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM futures_tpsl_configs c')) return Promise.resolve({ rows: [candidateRow], rowCount: 1 });
      if (sql.includes('UPDATE futures_tpsl_configs')) return Promise.resolve({ rows: [{ id: 'reboot-config-1' }], rowCount: 1 });
      if (sql.includes('FROM futures_positions')) return Promise.resolve({ rows: [{ id: 'reboot-pos-1', quantity: '10.0', status: 'OPEN' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    (mockFuturesService.placeOrder as any).mockResolvedValue({ order: { id: mockOrderId } });

    const results = await rebootedService.checkAllActiveTriggers({ SOLUSDT: '210' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('EXECUTED');
  });

  // ==========================================================================
  // Scenario K: Position closes before trigger
  // ==========================================================================
  it('Scenario K: position closes before trigger -> SKIPPED with no over-close', async () => {
    const candidate: ActiveTpSlCandidate = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      userId: 'user-uuid-mock',
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        // Position was manually closed or liquidated in the interim
        return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '0', status: 'CLOSED' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const result = await tpslService.executeTrigger(candidate, 'TP', '65000', '65500');

    expect(result).not.toBeNull();
    expect(result?.status).toBe('SKIPPED');
    expect(result?.reason).toBe('POSITION_ALREADY_CLOSED');
    expect(mockFuturesService.placeOrder).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario L: Partial/failed order handling
  // ==========================================================================
  it('Scenario L: order placement failure marks trigger as FAILED without throwing', async () => {
    const candidate: ActiveTpSlCandidate = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      userId: 'user-uuid-mock',
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '1.0', status: 'OPEN' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockRejectedValue(new Error('Internal order validation error'));

    const result = await tpslService.executeTrigger(candidate, 'TP', '65000', '65500');

    expect(result).not.toBeNull();
    expect(result?.status).toBe('FAILED');
    expect(result?.reason).toBe('Internal order validation error');
  });

  // ==========================================================================
  // Scenario M: NoPositionToCloseError race condition
  // ==========================================================================
  it('Scenario M: NoPositionToCloseError during placeOrder resolves gracefully to SKIPPED', async () => {
    const candidate: ActiveTpSlCandidate = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      userId: 'user-uuid-mock',
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: '1.0',
      leverage: 10,
      marginMode: 'ISOLATED',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE futures_tpsl_configs')) {
        return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      }
      if (sql.includes('FROM futures_positions')) {
        return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '1.0', status: 'OPEN' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    (mockFuturesService.placeOrder as any).mockRejectedValue(new NoPositionToCloseError('BTCUSDT', 'LONG'));

    const result = await tpslService.executeTrigger(candidate, 'TP', '65000', '65500');

    expect(result).not.toBeNull();
    expect(result?.status).toBe('SKIPPED');
    expect(result?.reason).toBe('POSITION_ALREADY_CLOSED');
  });

  // ==========================================================================
  // Scenario N: Idempotent re-evaluation
  // ==========================================================================
  it('Scenario N: subsequent sweep skips already-disabled configuration', async () => {
    // In this sweep, the DB query for active candidates returns 0 rows because config was disabled
    (mockDb.query as any).mockResolvedValue({ rows: [], rowCount: 0 });

    const results = await tpslService.checkAllActiveTriggers({ BTCUSDT: '70000' });
    expect(results).toHaveLength(0);
    expect(mockFuturesService.placeOrder).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario O & P: Customer ledger consistency & no duplicate order
  // ==========================================================================
  it('Scenario O & P: placeOrder is called with exact reduceOnly and closePosition invariants', async () => {
    const candidate: ActiveTpSlCandidate = {
      id: mockConfigId,
      positionId: mockPositionId,
      accountId: mockAccountId,
      userId: 'user-uuid-mock',
      symbol: 'BTCUSDT',
      positionSide: 'LONG',
      quantity: '3.5',
      leverage: 10,
      marginMode: 'ISOLATED',
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('UPDATE futures_tpsl_configs')) return Promise.resolve({ rows: [{ id: mockConfigId }], rowCount: 1 });
      if (sql.includes('FROM futures_positions')) return Promise.resolve({ rows: [{ id: mockPositionId, quantity: '3.5', status: 'OPEN' }], rowCount: 1 });
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    (mockFuturesService.placeOrder as any).mockResolvedValue({ order: { id: mockOrderId } });

    await tpslService.executeTrigger(candidate, 'TP', '65000', '65500');

    expect(mockFuturesService.placeOrder).toHaveBeenCalledTimes(1);
    expect(mockFuturesService.placeOrder).toHaveBeenCalledWith({
      userId: 'user-uuid-mock',
      accountId: mockAccountId,
      symbol: 'BTCUSDT',
      side: 'SELL',
      positionSide: 'LONG',
      type: 'MARKET',
      quantity: '3.5',
      leverage: 10,
      marginMode: 'ISOLATED',
      reduceOnly: true,
      closePosition: true,
      clientOrderId: expect.stringMatching(/^tpsl_tp_/),
    });
  });
});
