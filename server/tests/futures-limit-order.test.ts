import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { FuturesLimitOrderWorker } from '../src/workers/FuturesLimitOrderWorker';
import { FuturesService, FuturesExecutionResult } from '../src/services/futures/futures.service';
import { IMarkPriceProvider } from '../src/services/futures/mark-price.provider';
import { CircuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { IDatabaseConnection } from '../src/config/database';
import { LedgerService } from '../src/services/ledger/ledger.service';
import { FuturesPositionService } from '../src/services/futures/position.service';
import { FuturesRiskService } from '../src/services/futures/risk.service';
import { FuturesFeeService } from '../src/services/futures/fee.service';
import { INSURANCE_FUND_ACCOUNT_ID } from '../src/services/futures/insurance-fund.service';
import { FuturesError, FuturesErrorCode } from '../src/services/futures/errors';

describe('Phase 15B.5: Backend Resting Futures Limit Order Execution (Scenarios A–P)', () => {
  let mockDb: IDatabaseConnection;
  let mockLedger: LedgerService;
  let mockPositions: FuturesPositionService;
  let mockRisk: FuturesRiskService;
  let mockFeeSvc: FuturesFeeService;
  let mockMarkPrices: IMarkPriceProvider;
  let mockBreaker: CircuitBreakerService;
  let futuresService: FuturesService;
  let worker: FuturesLimitOrderWorker;

  const mockUserId = 'usr-test-100';
  const mockAccountId = 'acc-test-200';
  const mockOrderId = 'ord-test-300';
  const mockFuturesOrderId = 'fo-test-400';

  beforeEach(() => {
    vi.resetAllMocks();

    mockDb = {
      connect: vi.fn(),
      close: vi.fn(),
      query: vi.fn(),
      transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(mockDb)),
      healthCheck: vi.fn(),
      getStatus: vi.fn(),
    } as unknown as IDatabaseConnection;

    mockLedger = {
      getBalance: vi.fn().mockResolvedValue({
        availableBalance: '10000',
        lockedBalance: '10000',
        totalBalance: '20000',
      }),
      reserve: vi.fn().mockResolvedValue({}),
      release: vi.fn().mockResolvedValue({}),
      postTransaction: vi.fn().mockResolvedValue({}),
    } as unknown as LedgerService;

    mockPositions = {
      getOpenPosition: vi.fn().mockResolvedValue(null),
      getOpenPositions: vi.fn().mockResolvedValue([]),
      getPositionById: vi.fn().mockResolvedValue(null),
      createPosition: vi.fn().mockImplementation(async (params: any) => ({
        id: 'pos-created-1',
        accountId: params.accountId,
        symbol: params.symbol,
        side: params.side,
        quantity: params.quantity,
        entryPrice: params.entryPrice,
        markPrice: params.entryPrice,
        liquidationPrice: '40000',
        leverage: params.leverage,
        marginMode: params.marginMode,
        initialMargin: '500',
        maintenanceMargin: '25',
        realizedPnl: '0',
        status: 'OPEN',
        collateralAsset: params.collateralAsset,
        maintenanceMarginRate: params.maintenanceMarginRate,
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
      increasePosition: vi.fn().mockImplementation(async (pos: any, qty: any, price: any) => ({
        ...pos,
        quantity: String(Number(pos.quantity) + Number(qty)),
        entryPrice: price,
      })),
      reducePosition: vi.fn().mockImplementation(async (pos: any, qty: any, price: any) => ({
        updatedPosition: { ...pos, quantity: '0', status: 'CLOSED' },
        realizedPnl: '50',
        freedMargin: '500',
      })),
    } as unknown as FuturesPositionService;

    mockRisk = {
      isValidLeverage: vi.fn().mockReturnValue(true),
      calculateNotional: vi.fn().mockReturnValue('5000'),
      calculateInitialMargin: vi.fn().mockReturnValue('500'),
      calculateMaintenanceMargin: vi.fn().mockReturnValue('25'),
      hasSufficientMargin: vi.fn().mockReturnValue(true),
    } as unknown as FuturesRiskService;

    mockFeeSvc = {
      calculateExecutionFee: vi.fn().mockReturnValue({
        feeAmount: '2.5',
        feeRate: '0.0002',
        feeType: 'MAKER',
      }),
    } as unknown as FuturesFeeService;

    mockMarkPrices = {
      getMarkPrice: vi.fn().mockResolvedValue('50000'),
      getIndexPrice: vi.fn().mockResolvedValue('50000'),
    };

    mockBreaker = {
      isSubsystemOperational: vi.fn().mockResolvedValue({ operational: true, mode: 'ACTIVE' }),
    } as unknown as CircuitBreakerService;

    futuresService = new FuturesService(
      mockDb,
      mockLedger,
      mockRisk,
      mockPositions,
      mockFeeSvc,
      mockMarkPrices
    );

    worker = new FuturesLimitOrderWorker(
      1000,
      futuresService,
      mockMarkPrices,
      mockBreaker,
      mockDb
    );
  });

  afterEach(() => {
    worker.stop();
    vi.restoreAllMocks();
  });

  // ==========================================================================
  // Scenario A: Resting BUY becomes executable
  // ==========================================================================
  it('Scenario A: Resting BUY limit executes when markPrice <= limit price', async () => {
    // Resting BUY at 50000. Mark price drops to 48000
    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o')) {
        return Promise.resolve({
          rows: [
            {
              id: mockOrderId,
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '0.1',
              filled_quantity: '0',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: 'NEW',
              account_id: mockAccountId,
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'LONG',
              leverage: 10,
              margin_mode: 'ISOLATED',
              created_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await futuresService.executeRestingOrder(mockOrderId, '48000');

    expect(result).not.toBeNull();
    expect(result?.order.status).toBe('FILLED');
    expect(Number(result?.order.price)).toBe(50000);
    expect(result?.trade?.isMaker).toBe(true);
    expect(mockPositions.createPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: mockAccountId,
        symbol: 'BTCUSDT',
        side: 'LONG',
        leverage: 10,
      }),
      expect.anything()
    );
  });

  // ==========================================================================
  // Scenario B: Resting SELL becomes executable
  // ==========================================================================
  it('Scenario B: Resting SELL limit executes when markPrice >= limit price', async () => {
    // Resting SELL at 52000. Mark price rises to 53000
    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o')) {
        return Promise.resolve({
          rows: [
            {
              id: mockOrderId,
              symbol: 'BTCUSDT',
              side: 'SELL',
              type: 'LIMIT',
              price: '52000',
              quantity: '0.1',
              filled_quantity: '0',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: 'NEW',
              account_id: mockAccountId,
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'SHORT',
              leverage: 10,
              margin_mode: 'ISOLATED',
              created_at: new Date(),
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    const result = await futuresService.executeRestingOrder(mockOrderId, '53000');

    expect(result).not.toBeNull();
    expect(result?.order.status).toBe('FILLED');
    expect(Number(result?.trade?.price)).toBe(52000);
    expect(mockPositions.createPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: mockAccountId,
        symbol: 'BTCUSDT',
        side: 'SHORT',
      }),
      expect.anything()
    );
  });

  // ==========================================================================
  // Scenario C: Exact price boundary tests
  // ==========================================================================
  it('Scenario C: Evaluates exact price boundaries for BUY and SELL orders', async () => {
    // 1. BUY at 50000: markPrice = 50000 (equal) -> EXECUTES
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '50000',
          quantity: '0.1',
          remaining_quantity: '0.1',
          locked_amount: '500',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    const resEqualBuy = await futuresService.executeRestingOrder(mockOrderId, '50000');
    expect(resEqualBuy).not.toBeNull();
    expect(resEqualBuy?.order.status).toBe('FILLED');

    // 2. BUY at 50000: markPrice = 50000.01 (above) -> DOES NOT EXECUTE
    const resAboveBuy = await futuresService.executeRestingOrder(mockOrderId, '50000.01');
    expect(resAboveBuy).toBeNull();

    // 3. SELL at 50000: markPrice = 50000 (equal) -> EXECUTES
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'SELL',
          type: 'LIMIT',
          price: '50000',
          quantity: '0.1',
          remaining_quantity: '0.1',
          locked_amount: '500',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'SHORT',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    const resEqualSell = await futuresService.executeRestingOrder(mockOrderId, '50000');
    expect(resEqualSell).not.toBeNull();

    // 4. SELL at 50000: markPrice = 49999.99 (below) -> DOES NOT EXECUTE
    const resBelowSell = await futuresService.executeRestingOrder(mockOrderId, '49999.99');
    expect(resBelowSell).toBeNull();
  });

  // ==========================================================================
  // Scenario D: Non-crossing order remains NEW
  // ==========================================================================
  it('Scenario D: Non-crossing order remains in NEW state', async () => {
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '45000',
          quantity: '0.1',
          remaining_quantity: '0.1',
          locked_amount: '450',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    // Mark price 50000 > BUY limit 45000
    const res = await futuresService.executeRestingOrder(mockOrderId, '50000');
    expect(res).toBeNull();
    // Verify no trades or position changes occurred
    expect(mockPositions.createPosition).not.toHaveBeenCalled();
    expect(mockPositions.increasePosition).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario E: Duplicate worker evaluation
  // ==========================================================================
  it('Scenario E: Duplicate worker evaluation is idempotent (second run returns null)', async () => {
    let orderStatus = 'NEW';
    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o')) {
        if (orderStatus !== 'NEW') {
          return Promise.resolve({ rows: [] }); // Locked filter status IN ('NEW', 'PARTIALLY_FILLED')
        }
        return Promise.resolve({
          rows: [
            {
              id: mockOrderId,
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '0.1',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: orderStatus,
              account_id: mockAccountId,
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'LONG',
              leverage: 10,
              margin_mode: 'ISOLATED',
              created_at: new Date(),
            },
          ],
        });
      }
      if (sql.includes('UPDATE orders SET status =')) {
        orderStatus = 'FILLED';
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });

    // First execution
    const res1 = await futuresService.executeRestingOrder(mockOrderId, '49000');
    expect(res1).not.toBeNull();
    expect(res1?.order.status).toBe('FILLED');

    // Second execution on already FILLED order
    const res2 = await futuresService.executeRestingOrder(mockOrderId, '49000');
    expect(res2).toBeNull();
  });

  // ==========================================================================
  // Scenario F: Concurrent worker evaluation
  // ==========================================================================
  it('Scenario F: Concurrent evaluations on the same order result in exactly one execution', async () => {
    let orderClaimed = false;

    (mockDb.query as any).mockImplementation(async (sql: string) => {
      if (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o')) {
        if (orderClaimed) {
          // Second transaction sees already modified or locked row
          return { rows: [] };
        }
        orderClaimed = true;
        return {
          rows: [
            {
              id: mockOrderId,
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '0.1',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: 'NEW',
              account_id: mockAccountId,
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'LONG',
              leverage: 10,
              margin_mode: 'ISOLATED',
              created_at: new Date(),
            },
          ],
        };
      }
      return { rows: [] };
    });

    // Run two evaluations in parallel
    const [run1, run2] = await Promise.all([
      futuresService.executeRestingOrder(mockOrderId, '48000'),
      futuresService.executeRestingOrder(mockOrderId, '48000'),
    ]);

    const successes = [run1, run2].filter(r => r !== null);
    expect(successes.length).toBe(1);
  });

  // ==========================================================================
  // Scenario G: Cancel race
  // ==========================================================================
  it('Scenario G: Cancel race yields exactly one terminal state; never executes cancelled order', async () => {
    let orderStatus = 'NEW';

    (mockDb.query as any).mockImplementation((sql: string, params: any[]) => {
      if (sql.includes('FROM orders WHERE id = $1 FOR UPDATE') || (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o'))) {
        if (orderStatus !== 'NEW') {
          return Promise.resolve({ rows: [] });
        }
        return Promise.resolve({
          rows: [
            {
              id: mockOrderId,
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '0.1',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: orderStatus,
              account_id: mockAccountId,
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'LONG',
              leverage: 10,
              margin_mode: 'ISOLATED',
              created_at: new Date(),
            },
          ],
        });
      }
      if (sql.includes('SELECT id, user_id AS "userId" FROM accounts WHERE id = $1')) {
        return Promise.resolve({ rows: [{ id: mockAccountId, userId: mockUserId }] });
      }
      if (sql.includes('UPDATE orders SET status =') && (params?.[0] === 'CANCELLED' || sql.includes('CANCELLED'))) {
        orderStatus = 'CANCELLED';
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });

    // 1. User cancels order first
    const cancelled = await futuresService.cancelOrder(mockUserId, mockOrderId);
    expect(cancelled.status).toBe('CANCELLED');
    expect(mockLedger.release).toHaveBeenCalled();

    // 2. Worker attempts execution on cancelled order
    const execResult = await futuresService.executeRestingOrder(mockOrderId, '45000');
    expect(execResult).toBeNull();
    expect(mockPositions.createPosition).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario H: Insufficient margin race
  // ==========================================================================
  it('Scenario H: Insufficient margin race transitions order safely to REJECTED', async () => {
    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o')) {
        return Promise.resolve({
          rows: [
            {
              id: mockOrderId,
              symbol: 'BTCUSDT',
              side: 'BUY',
              type: 'LIMIT',
              price: '50000',
              quantity: '0.1',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: 'NEW',
              account_id: mockAccountId,
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'LONG',
              leverage: 10,
              margin_mode: 'ISOLATED',
              created_at: new Date(),
            },
          ],
        });
      }
      if (sql.includes("UPDATE orders SET status = 'REJECTED'")) {
        return Promise.resolve({ rowCount: 1 });
      }
      return Promise.resolve({ rows: [] });
    });

    // Simulate account locked balance deficit (only 100 available vs 500 required)
    (mockLedger.getBalance as any).mockResolvedValueOnce({
      availableBalance: '0',
      lockedBalance: '100',
      totalBalance: '100',
    });

    const result = await futuresService.executeRestingOrder(mockOrderId, '48000');
    expect(result).toBeNull();
    // Verify order was transitioned to REJECTED and no position was created
    expect(mockDb.query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE orders SET status = 'REJECTED'"),
      expect.anything()
    );
    expect(mockPositions.createPosition).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario I: Restart recovery
  // ==========================================================================
  it('Scenario I: Orders in PostgreSQL survive worker restart and execute on subsequent tick', async () => {
    let orderRow = {
      id: mockOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY',
      price: '50000',
      quantity: '0.1',
      account_id: mockAccountId,
      created_at: new Date(),
    };

    (mockDb.query as any).mockImplementation((sql: string) => {
      if (sql.includes('SELECT o.id, o.symbol, o.side, o.price')) {
        return Promise.resolve({ rows: [orderRow] });
      }
      if (sql.includes('FROM orders o') && sql.includes('FOR UPDATE OF o')) {
        return Promise.resolve({
          rows: [
            {
              ...orderRow,
              type: 'LIMIT',
              remaining_quantity: '0.1',
              locked_amount: '500',
              locked_asset: 'FUTURES_USDT',
              status: 'NEW',
              user_id: mockUserId,
              fo_id: mockFuturesOrderId,
              position_side: 'LONG',
              leverage: 10,
              margin_mode: 'ISOLATED',
            },
          ],
        });
      }
      return Promise.resolve({ rows: [] });
    });

    // Start worker, stop worker, restart worker
    worker.start();
    expect(worker.isRunning).toBe(true);
    worker.stop();
    expect(worker.isRunning).toBe(false);

    // Restart worker
    worker.start();
    expect(worker.isRunning).toBe(true);

    // Trigger sweep with crossing price
    const executed = await worker.checkAndExecuteOrders({ BTCUSDT: '49000' });
    expect(executed.length).toBe(1);
    expect(executed[0].order.status).toBe('FILLED');
  });

  // ==========================================================================
  // Scenario J: Missing or stale market data
  // ==========================================================================
  it('Scenario J: Missing or non-positive mark price fails closed (order remains NEW)', async () => {
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          price: '50000',
          quantity: '0.1',
          account_id: mockAccountId,
          created_at: new Date(),
        },
      ],
    });

    // Case 1: Error thrown during price lookup
    (mockMarkPrices.getMarkPrice as any).mockRejectedValueOnce(new Error('RPC timeout'));
    const sweep1 = await worker.checkAndExecuteOrders();
    expect(sweep1.length).toBe(0);

    // Case 2: Zero or negative price returned
    (mockMarkPrices.getMarkPrice as any).mockResolvedValueOnce('0');
    const sweep2 = await worker.checkAndExecuteOrders();
    expect(sweep2.length).toBe(0);

    expect(mockPositions.createPosition).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario K: Full fill
  // ==========================================================================
  it('Scenario K: Full fill updates remaining quantity to zero and status to FILLED', async () => {
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '50000',
          quantity: '0.5',
          filled_quantity: '0',
          remaining_quantity: '0.5',
          locked_amount: '2500',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    const result = await futuresService.executeRestingOrder(mockOrderId, '49000');
    expect(result).not.toBeNull();
    expect(result?.order.status).toBe('FILLED');
    expect(Number(result?.order.filledQuantity)).toBe(0.5);
    expect(Number(result?.order.remainingQuantity)).toBe(0);
  });

  // ==========================================================================
  // Scenario L: Partial fill support
  // ==========================================================================
  it('Scenario L: Partial fill advances filledQuantity and marks status PARTIALLY_FILLED', async () => {
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '50000',
          quantity: '1.0',
          filled_quantity: '0',
          remaining_quantity: '1.0',
          locked_amount: '5000',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    // Execute partial fill for 0.4
    const partialResult = await futuresService.executeRestingOrder(mockOrderId, '49000', '0.4');
    expect(partialResult).not.toBeNull();
    expect(partialResult?.order.status).toBe('PARTIALLY_FILLED');
    expect(Number(partialResult?.order.filledQuantity)).toBe(0.4);
    expect(Number(partialResult?.order.remainingQuantity)).toBe(0.6);
  });

  // ==========================================================================
  // Scenario M: Duplicate execution prevention
  // ==========================================================================
  it('Scenario M: Non-NEW order is rejected by row lock filter and cannot execute again', async () => {
    (mockDb.query as any).mockResolvedValue({ rows: [] }); // query for status IN ('NEW', 'PARTIALLY_FILLED') returns empty

    const result = await futuresService.executeRestingOrder(mockOrderId, '48000');
    expect(result).toBeNull();
    expect(mockPositions.createPosition).not.toHaveBeenCalled();
    expect(mockLedger.postTransaction).not.toHaveBeenCalled();
  });

  // ==========================================================================
  // Scenario N: Ledger balance verification
  // ==========================================================================
  it('Scenario N: Ledger transactions are balanced double-entry (equal debits and credits)', async () => {
    // Closing order with realized PnL
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'SELL',
          type: 'LIMIT',
          price: '60000',
          quantity: '0.1',
          remaining_quantity: '0.1',
          locked_amount: '0',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    (mockPositions.getOpenPosition as any).mockResolvedValue({
      id: 'pos-long-1',
      accountId: mockAccountId,
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '0.1',
      entryPrice: '50000',
      collateralAsset: 'FUTURES_USDT',
    });

    const result = await futuresService.executeRestingOrder(mockOrderId, '60000');
    expect(result).not.toBeNull();

    // Verify ledger calls posted
    const postCalls = (mockLedger.postTransaction as any).mock.calls;
    expect(postCalls.length).toBeGreaterThan(0);

    for (const call of postCalls) {
      const txDto = call[0];
      const entries = txDto.entries;
      let totalDebit = 0;
      let totalCredit = 0;
      for (const e of entries) {
        if (e.direction === 'DEBIT') totalDebit += Number(e.amount);
        if (e.direction === 'CREDIT') totalCredit += Number(e.amount);
      }
      expect(totalDebit).toBeCloseTo(totalCredit);
    }
  });

  // ==========================================================================
  // Scenario O: Position consistency
  // ==========================================================================
  it('Scenario O: Position consistency preserves exact entryPrice, leverage, and maintenance rate', async () => {
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'ETHUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '3000',
          quantity: '1.0',
          remaining_quantity: '1.0',
          locked_amount: '150',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 20,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    const result = await futuresService.executeRestingOrder(mockOrderId, '2950');
    expect(result).not.toBeNull();
    expect(mockPositions.createPosition).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'ETHUSDT',
        side: 'LONG',
        leverage: 20,
        marginMode: 'ISOLATED',
      }),
      expect.anything()
    );
    const createdParams = (mockPositions.createPosition as any).mock.calls[0][0];
    expect(Number(createdParams.quantity)).toBe(1.0);
    expect(Number(createdParams.entryPrice)).toBe(3000);
  });

  // ==========================================================================
  // Scenario P: Customer isolation
  // ==========================================================================
  it('Scenario P: Customer isolation guarantees no other customer account is touched', async () => {
    (mockDb.query as any).mockResolvedValue({
      rows: [
        {
          id: mockOrderId,
          symbol: 'BTCUSDT',
          side: 'BUY',
          type: 'LIMIT',
          price: '50000',
          quantity: '0.1',
          remaining_quantity: '0.1',
          locked_amount: '500',
          locked_asset: 'FUTURES_USDT',
          status: 'NEW',
          account_id: mockAccountId,
          user_id: mockUserId,
          fo_id: mockFuturesOrderId,
          position_side: 'LONG',
          leverage: 10,
          margin_mode: 'ISOLATED',
          created_at: new Date(),
        },
      ],
    });

    await futuresService.executeRestingOrder(mockOrderId, '49000');

    // Verify all ledger operations strictly use mockAccountId or system accounts
    const postCalls = (mockLedger.postTransaction as any).mock.calls;
    for (const call of postCalls) {
      const txDto = call[0];
      expect(txDto.accountId).toBe(mockAccountId);
      for (const entry of txDto.entries) {
        expect([
          mockAccountId,
          INSURANCE_FUND_ACCOUNT_ID,
          '11111111-1111-1111-1111-111111111111', // house fee account
        ]).toContain(entry.accountId);
      }
    }
  });
});
