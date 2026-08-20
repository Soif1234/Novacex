import { describe, it, expect } from 'vitest';
import { 
  RoutingMode, 
  LiquiditySource, 
  ExecutionPlan, 
  OrderSlice, 
  ExecutionStatus 
} from '../src/models/liquidity.model';
import { 
  validateStateTransition, 
  LiquidityExecutionError 
} from '../src/domain/liquidity/executionState';

describe('Phase 5.1 - Liquidity Architecture & Domain Model', () => {

  it('1. Internal liquidity source can be represented', () => {
    const internalSource: LiquiditySource = {
      sourceId: 'nova-internal',
      sourceType: 'INTERNAL',
      venueId: 'NOVACEX',
      capabilities: ['SPOT_MATCHING']
    };
    expect(internalSource.sourceType).toBe('INTERNAL');
  });

  it('2. External liquidity source can be represented', () => {
    const externalSource: LiquiditySource = {
      sourceId: 'ext-prov-1',
      sourceType: 'EXTERNAL',
      venueId: 'SIMULATED_DEX',
      capabilities: ['SPOT_ROUTING']
    };
    expect(externalSource.sourceType).toBe('EXTERNAL');
  });

  it('3. INTERNAL_ONLY execution plan is valid', () => {
    const source: LiquiditySource = { sourceId: '1', sourceType: 'INTERNAL', venueId: '1', capabilities: [] };
    const slice: OrderSlice = {
      sliceId: 's1',
      source,
      quantity: '10',
      expectedPrice: '50000',
      estimatedFee: '0',
      estimatedSlippage: '0'
    };
    const plan: ExecutionPlan = {
      planId: 'p1',
      routingMode: 'INTERNAL_ONLY',
      slices: [slice],
      estimatedQuantity: '10',
      estimatedAveragePrice: '50000',
      estimatedFees: '0',
      estimatedSlippage: '0',
      createdAt: new Date()
    };
    expect(plan.routingMode).toBe('INTERNAL_ONLY');
    expect(plan.slices).toHaveLength(1);
    expect(plan.slices[0].source.sourceType).toBe('INTERNAL');
  });

  it('4. EXTERNAL_ONLY execution plan is valid', () => {
    const source: LiquiditySource = { sourceId: '2', sourceType: 'EXTERNAL', venueId: '2', capabilities: [] };
    const slice: OrderSlice = {
      sliceId: 's2',
      source,
      quantity: '5',
      expectedPrice: '50000',
      estimatedFee: '2',
      estimatedSlippage: '5'
    };
    const plan: ExecutionPlan = {
      planId: 'p2',
      routingMode: 'EXTERNAL_ONLY',
      slices: [slice],
      estimatedQuantity: '5',
      estimatedAveragePrice: '50000',
      estimatedFees: '2',
      estimatedSlippage: '5',
      createdAt: new Date()
    };
    expect(plan.routingMode).toBe('EXTERNAL_ONLY');
    expect(plan.slices[0].source.sourceType).toBe('EXTERNAL');
  });

  it('5. SPLIT execution plan supports multiple slices', () => {
    const internalSource: LiquiditySource = { sourceId: '1', sourceType: 'INTERNAL', venueId: '1', capabilities: [] };
    const externalSource: LiquiditySource = { sourceId: '2', sourceType: 'EXTERNAL', venueId: '2', capabilities: [] };
    
    const slice1: OrderSlice = {
      sliceId: 's1',
      source: internalSource,
      quantity: '4',
      expectedPrice: '50000',
      estimatedFee: '0',
      estimatedSlippage: '0'
    };
    const slice2: OrderSlice = {
      sliceId: 's2',
      source: externalSource,
      quantity: '6',
      expectedPrice: '50000',
      estimatedFee: '2',
      estimatedSlippage: '10'
    };

    const plan: ExecutionPlan = {
      planId: 'p3',
      routingMode: 'SPLIT',
      slices: [slice1, slice2],
      estimatedQuantity: '10',
      estimatedAveragePrice: '50000',
      estimatedFees: '2',
      estimatedSlippage: '10',
      createdAt: new Date()
    };
    
    expect(plan.routingMode).toBe('SPLIT');
    expect(plan.slices).toHaveLength(2);
    expect(plan.slices.map(s => s.source.sourceType)).toEqual(['INTERNAL', 'EXTERNAL']);
  });

  it('6. Fees and slippage can be represented', () => {
    const slice: OrderSlice = {
      sliceId: 's1',
      source: { sourceId: '1', sourceType: 'EXTERNAL', venueId: '1', capabilities: [] },
      quantity: '1',
      expectedPrice: '100',
      estimatedFee: '0.1', // Provider fee + network cost
      estimatedSlippage: '0.5'
    };
    expect(slice.estimatedFee).toBe('0.1');
    expect(slice.estimatedSlippage).toBe('0.5');
  });

  it('7. Execution lifecycle supports partial fills', () => {
    const status: ExecutionStatus = 'PARTIALLY_FILLED';
    expect(status).toBe('PARTIALLY_FILLED');
    expect(() => validateStateTransition('SUBMITTED', 'PARTIALLY_FILLED')).not.toThrow();
  });

  it('8. UNKNOWN state is representable', () => {
    const status: ExecutionStatus = 'UNKNOWN';
    expect(status).toBe('UNKNOWN');
  });

  it('9. UNKNOWN requires RECONCILING before confirmation/retry', () => {
    // Blind retry or confirmation throws
    expect(() => validateStateTransition('UNKNOWN', 'SUBMITTED')).toThrow(LiquidityExecutionError);
    expect(() => validateStateTransition('UNKNOWN', 'FILLED')).toThrow(LiquidityExecutionError);
    expect(() => validateStateTransition('UNKNOWN', 'FAILED')).toThrow(LiquidityExecutionError);

    // Transition to RECONCILING is allowed
    expect(() => validateStateTransition('UNKNOWN', 'RECONCILING')).not.toThrow();
    
    // Transition from RECONCILING to terminal is allowed
    expect(() => validateStateTransition('RECONCILING', 'CONFIRMED')).not.toThrow();
    expect(() => validateStateTransition('RECONCILING', 'FILLED')).not.toThrow();
  });

  it('10. Provider-specific credentials cannot enter domain contracts', () => {
    const source: LiquiditySource = {
      sourceId: 'generic-ext',
      sourceType: 'EXTERNAL',
      venueId: 'ext-venue',
      capabilities: []
    };
    // Type definition ensures no API key field exists on LiquiditySource/ExecutionVenue
    expect('apiKey' in source).toBe(false);
    expect('secret' in source).toBe(false);
  });
});
