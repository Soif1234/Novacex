import { describe, it, expect } from 'vitest';
import { EconomicsCalculator, EconomicsParams, SliceResult } from '../src/domain/liquidity/economics';
import { ExecutionPlan, OrderSlice, LiquiditySource } from '../src/models/liquidity.model';
import { ProviderError } from '../src/domain/liquidity/errors';

describe('Phase 5.7 - Execution Fees, Slippage & User Economics', () => {

  const createMockSource = (type: 'INTERNAL' | 'EXTERNAL', venueId: string): LiquiditySource => ({
    sourceId: venueId,
    sourceType: type,
    venueId,
    capabilities: ['SPOT']
  });

  const createPlan = (slices: OrderSlice[], estimatedAvgPrice: string): ExecutionPlan => ({
    planId: 'p1',
    routingMode: 'SPLIT',
    slices,
    estimatedQuantity: '10.0',
    estimatedAveragePrice: estimatedAvgPrice,
    estimatedFees: '0.0',
    estimatedSlippage: '0.0',
    createdAt: new Date()
  });

  const createSlice = (sourceType: 'INTERNAL' | 'EXTERNAL', venueId: string, qty: string, expectedPrice: string): OrderSlice => ({
    sliceId: `s-${venueId}`,
    source: createMockSource(sourceType, venueId),
    quantity: qty,
    expectedPrice,
    estimatedFee: '0',
    estimatedSlippage: '0'
  });

  it('1, 5, 26, 27, 28, 17. Provider/NovaCEX Fee calculation, separation & Split execution aggregation', () => {
    const plan = createPlan([], '100');
    
    const sliceResults: SliceResult[] = [
      {
        slice: createSlice('EXTERNAL', 'BINANCE', '4.0', '100'),
        result: { status: 'FILLED', executedQuantity: '4.0', averagePrice: '100', fees: '2.0', slippage: '0', providerReference: '', reconciliationRequired: false },
        providerFeeAsset: 'USDT',
        novaCEXFeeAmount: '0.5',
        novaCEXFeeAsset: 'USDT'
      },
      {
        slice: createSlice('INTERNAL', 'NOVACEX', '6.0', '100'),
        result: { status: 'FILLED', executedQuantity: '6.0', averagePrice: '100', fees: '0.2', slippage: '0', providerReference: '', reconciliationRequired: false },
        novaCEXFeeAmount: '1.0',
        novaCEXFeeAsset: 'USDT'
      }
    ];

    const params: EconomicsParams = {
      side: 'BUY',
      requestedQuantity: '10.0',
      referencePrice: '100',
      quoteAsset: 'USDT',
      feeExchangeRates: { 'USDT': '1' }
    };

    const eco = EconomicsCalculator.calculateEconomics(plan, sliceResults, params);
    
    expect(eco.executedQuantity).toBe('10.00000000');
    expect(eco.providerFees.length).toBe(1);
    expect(eco.providerFees[0].amount).toBe('2.00000000');
    
    expect(eco.networkCosts.length).toBe(1);
    expect(eco.networkCosts[0].amount).toBe('0.20000000'); // From internal slice 'fees'
    
    expect(eco.novaCEXFees.length).toBe(2);
    expect(eco.totalExternalCostsByAsset['USDT']).toBe('2.00000000');
    expect(eco.totalNovaCEXCostsByAsset['USDT']).toBe('1.50000000');
    
    // Total fees = 2.0 (provider) + 0.2 (network) + 1.5 (novaCEX) = 3.7
    // Notional = 1000. Total Cost = 1003.7
    expect(eco.effectiveExecutionCost).toBe('1003.70000000');
    expect(eco.effectiveExecutionPrice).toBe('100.37000000');
  });

  it('4, 6, 7. Fee asset handling & BUY/SELL effective price (No double counting)', () => {
    const plan = createPlan([], '100');
    
    const sliceResults: SliceResult[] = [
      {
        slice: createSlice('EXTERNAL', 'BINANCE', '10.0', '100'),
        result: { status: 'FILLED', executedQuantity: '10.0', averagePrice: '100', fees: '0.01', slippage: '0', providerReference: '', reconciliationRequired: false },
        providerFeeAsset: 'BTC' // Fee in BTC
      }
    ];

    const params: EconomicsParams = {
      side: 'BUY',
      requestedQuantity: '10.0',
      referencePrice: '100',
      quoteAsset: 'USDT',
      feeExchangeRates: { 'USDT': '1', 'BTC': '50000' } // 0.01 BTC = 500 USDT
    };

    const ecoBuy = EconomicsCalculator.calculateEconomics(plan, sliceResults, params);
    // Notional = 1000. Fees in quote = 500. Total Cost = 1500. Avg price = 150.
    expect(ecoBuy.effectiveExecutionCost).toBe('1500.00000000');
    expect(ecoBuy.effectiveExecutionPrice).toBe('150.00000000');

    // Sell side
    const ecoSell = EconomicsCalculator.calculateEconomics(plan, sliceResults, { ...params, side: 'SELL' });
    // Proceeds = 1000 - 500 = 500. Avg price = 50.
    expect(ecoSell.effectiveExecutionProceeds).toBe('500.00000000');
    expect(ecoSell.effectiveExecutionPrice).toBe('50.00000000');
  });

  it('8, 9, 10, 11, 12, 25. Estimated vs Actual Slippage (Positive/Zero)', () => {
    // Reference price = 100
    // Estimated average price = 101
    // Actual average price = 102
    const plan = createPlan([], '101'); 
    
    const sliceResults: SliceResult[] = [
      {
        slice: createSlice('EXTERNAL', 'BINANCE', '10.0', '100'),
        result: { status: 'FILLED', executedQuantity: '10.0', averagePrice: '102', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: false }
      }
    ];

    const params: EconomicsParams = {
      side: 'BUY',
      requestedQuantity: '10.0',
      referencePrice: '100',
      quoteAsset: 'USDT',
      feeExchangeRates: { 'USDT': '1' }
    };

    const ecoBuy = EconomicsCalculator.calculateEconomics(plan, sliceResults, params);
    // BUY Slippage: price - ref
    expect(ecoBuy.estimatedSlippage).toBe('1.00000000');
    expect(ecoBuy.actualSlippage).toBe('2.00000000');

    const ecoSell = EconomicsCalculator.calculateEconomics(plan, sliceResults, { ...params, side: 'SELL' });
    // SELL Slippage: ref - price
    expect(ecoSell.estimatedSlippage).toBe('-1.00000000');
    expect(ecoSell.actualSlippage).toBe('-2.00000000');
  });

  it('13, 14, 16. Partial Fills & Weighted Average Price', () => {
    const plan = createPlan([], '100');
    
    const sliceResults: SliceResult[] = [
      {
        slice: createSlice('EXTERNAL', 'BINANCE', '10.0', '100'),
        result: { status: 'PARTIALLY_FILLED', executedQuantity: '4.0', averagePrice: '90', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: false }
      },
      {
        slice: createSlice('EXTERNAL', 'KRAKEN', '10.0', '100'),
        result: { status: 'PARTIALLY_FILLED', executedQuantity: '6.0', averagePrice: '110', fees: '0', slippage: '0', providerReference: '', reconciliationRequired: false }
      }
    ];

    const params: EconomicsParams = {
      side: 'BUY',
      requestedQuantity: '20.0',
      referencePrice: '100',
      quoteAsset: 'USDT',
      feeExchangeRates: { 'USDT': '1' }
    };

    const eco = EconomicsCalculator.calculateEconomics(plan, sliceResults, params);
    // (4 * 90 + 6 * 110) / 10 = (360 + 660) / 10 = 102
    expect(eco.executedQuantity).toBe('10.00000000');
    expect(eco.averageExecutionPrice).toBe('102.00000000');
  });

  it('19, 20, 21, 22. Reject invalid negative/non-finite values', () => {
    const plan = createPlan([], '100');
    const params: EconomicsParams = { side: 'BUY', requestedQuantity: '10.0', referencePrice: '100', quoteAsset: 'USDT', feeExchangeRates: { 'USDT': '1' } };
    
    const runWith = (qty: string, price: string, fee: string) => {
      const sliceResults: SliceResult[] = [{
        slice: createSlice('EXTERNAL', 'BINANCE', '10.0', '100'),
        result: { status: 'FILLED', executedQuantity: qty, averagePrice: price, fees: fee, slippage: '0', providerReference: '', reconciliationRequired: false }
      }];
      return () => EconomicsCalculator.calculateEconomics(plan, sliceResults, params);
    };

    expect(runWith('-1', '100', '0')).toThrow(/Negative or invalid executed quantity/);
    expect(runWith('10', '-100', '0')).toThrow(/Negative or invalid execution price/);
    expect(runWith('10', '100', '-1')).toThrow(/Invalid negative fee/);
    expect(runWith('Infinity', '100', '0')).toThrow(/Negative or invalid executed quantity/);
    expect(runWith('10', 'NaN', '0')).toThrow(/Negative or invalid execution price/);
  });

  it('23, 24. Missing reference price and zero executed quantity', () => {
    const plan = createPlan([], '100');
    const params: EconomicsParams = { side: 'BUY', requestedQuantity: '10.0', referencePrice: '', quoteAsset: 'USDT', feeExchangeRates: { 'USDT': '1' } };
    
    expect(() => EconomicsCalculator.calculateEconomics(plan, [], params)).toThrow(/Missing or invalid reference price/);

    const validParams = { ...params, referencePrice: '100' };
    const eco = EconomicsCalculator.calculateEconomics(plan, [], validParams);
    
    expect(eco.executedQuantity).toBe('0.00000000');
    expect(eco.averageExecutionPrice).toBe('0.00000000');
    expect(eco.actualSlippage).toBe('0.00000000');
    expect(eco.effectiveExecutionPrice).toBe('0.00000000');
  });

  it('29, 30, 31, 32, 33. Precision behavior, pure domain logic (no ledger mutation/network/credentials)', () => {
    const plan = createPlan([], '100');
    const sliceResults: SliceResult[] = [{
      slice: createSlice('EXTERNAL', 'BINANCE', '10.0', '100'),
      result: { status: 'FILLED', executedQuantity: '0.12345678', averagePrice: '12345.67890123', fees: '0.00000001', slippage: '0', providerReference: '', reconciliationRequired: false },
      providerFeeAsset: 'USDT',
      novaCEXFeeAmount: '0.00000002',
      novaCEXFeeAsset: 'USDT'
    }];
    const params: EconomicsParams = { side: 'BUY', requestedQuantity: '10.0', referencePrice: '100', quoteAsset: 'USDT', feeExchangeRates: { 'USDT': '1' } };
    
    const eco = EconomicsCalculator.calculateEconomics(plan, sliceResults, params);
    
    // Verification of fixed 8 decimal places mapping
    expect(eco.executedQuantity).toBe('0.12345678');
    expect(eco.providerFees[0].amount).toBe('0.00000001');
    expect(eco.novaCEXFees[0].amount).toBe('0.00000002');
    
    const serialized = JSON.stringify(eco);
    expect(serialized).not.toContain('apiKey'); // No credentials
    expect(serialized).not.toContain('balance'); // No wallet mutation
  });

});
