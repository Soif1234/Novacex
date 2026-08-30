import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { liquidationWorker } from '../src/workers/LiquidationWorker';
import { db } from '../src/config/database';
import { futuresLiquidationService } from '../src/services/futures/liquidation.service';
import { circuitBreakerService } from '../src/services/system/circuit-breaker.service';
import { logger } from '../src/config/logger';

describe('LiquidationWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(logger, 'error').mockImplementation(() => { return undefined as any });
    vi.spyOn(logger, 'info').mockImplementation(() => { return undefined as any });
    // Default: futures trading operational so the worker proceeds.
    vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({
      operational: true,
      reason: null,
      mode: 'SYSTEM_ACTIVE',
    } as any);
  });

  afterEach(() => {
    liquidationWorker.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('1. & 2. Worker starts and stops correctly', () => {
    expect((liquidationWorker as any).isRunning).toBe(false);
    liquidationWorker.start();
    expect((liquidationWorker as any).isRunning).toBe(true);
    expect((liquidationWorker as any).intervalId).not.toBeNull();
    
    liquidationWorker.stop();
    expect((liquidationWorker as any).isRunning).toBe(false);
    expect((liquidationWorker as any).intervalId).toBeNull();
  });

  it('1b. Worker pauses the cycle when futures trading is halted (fail-closed)', async () => {
    vi.spyOn(circuitBreakerService, 'isSubsystemOperational').mockResolvedValue({
      operational: false,
      reason: 'Emergency halt',
      mode: 'HALT_ALL',
    } as any);
    const dbSpy = vi.spyOn(db, 'query');
    (liquidationWorker as any).isRunning = true;
    await (liquidationWorker as any).pollAndLiquidate();
    // No symbol query should run while halted.
    expect(dbSpy).not.toHaveBeenCalled();
  });

  it('11. LiquidationNotEligibleError is handled safely', async () => {
    // Mock db to return a fake position
    vi.spyOn(db, 'query')
      .mockResolvedValueOnce({ rows: [{ symbol: 'BTCUSDT' }] } as any) // first query: distinct symbols
      .mockResolvedValueOnce({ rows: [{ id: 'pos_1' }] } as any);      // second query: positions

    // Mock the service to throw the safe error
    class LiquidationNotEligibleError extends Error {
      constructor() {
        super('Safe');
        this.name = 'LiquidationNotEligibleError';
      }
    }
    vi.spyOn(futuresLiquidationService, 'evaluateAndLiquidate').mockRejectedValueOnce(new LiquidationNotEligibleError());
    
    (liquidationWorker as any).isRunning = true;
    await (liquidationWorker as any).pollAndLiquidate();
    
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('12. Unexpected errors do not silently corrupt state', async () => {
    vi.spyOn(db, 'query')
      .mockResolvedValueOnce({ rows: [{ symbol: 'BTCUSDT' }] } as any)
      .mockResolvedValueOnce({ rows: [{ id: 'pos_1' }] } as any);

    // Mock the service to throw an unexpected error
    vi.spyOn(futuresLiquidationService, 'evaluateAndLiquidate').mockRejectedValueOnce(new Error('FATAL DB ERROR'));
    
    (liquidationWorker as any).isRunning = true;
    await (liquidationWorker as any).pollAndLiquidate();
    
    expect(logger.error).toHaveBeenCalledWith('Worker failed to evaluate position for liquidation', expect.any(Object));
  });
});