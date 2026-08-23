import { describe, it, expect } from 'vitest';
import { validateDemoOrder } from './orderValidation';
import { DemoOrder } from '../types/orders';

describe.skip('Order Validation', () => {
  const baseOrder: DemoOrder = {
    id: 'ord-123',
    accountId: 'acc-456',
    symbol: 'BTCUSDT',
    side: 'BUY',
    type: 'MARKET',
    quantity: '1.5',
    status: 'PENDING',
    createdAt: 1718000000000,
    updatedAt: 1718000000000,
  };

  it('should validate a correct MARKET order', () => {
    const result = validateDemoOrder(baseOrder);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate a correct LIMIT order', () => {
    const limitOrder: DemoOrder = {
      ...baseOrder,
      type: 'LIMIT',
      price: '65000.50',
    };
    const result = validateDemoOrder(limitOrder);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should reject LIMIT order without a price', () => {
    const limitOrder: Partial<DemoOrder> = {
      ...baseOrder,
      type: 'LIMIT',
    };
    const result = validateDemoOrder(limitOrder);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Price is required for LIMIT orders');
  });

  it('should reject LIMIT order with a negative price', () => {
    const limitOrder: DemoOrder = {
      ...baseOrder,
      type: 'LIMIT',
      price: '-500',
    };
    const result = validateDemoOrder(limitOrder);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Price must be strictly positive');
  });

  it('should reject invalid quantity (zero or negative)', () => {
    const zeroQtyOrder: DemoOrder = { ...baseOrder, quantity: '0' };
    const result1 = validateDemoOrder(zeroQtyOrder);
    expect(result1.valid).toBe(false);
    expect(result1.errors).toContain('Quantity must be strictly positive');

    const negQtyOrder: DemoOrder = { ...baseOrder, quantity: '-2' };
    const result2 = validateDemoOrder(negQtyOrder);
    expect(result2.valid).toBe(false);
    expect(result2.errors).toContain('Quantity must be strictly positive');
  });

  it('should reject invalid or missing side', () => {
    const invalidSide: any = { ...baseOrder, side: 'INVALID' };
    const result = validateDemoOrder(invalidSide);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Side must be BUY or SELL');
  });

  it('should reject invalid or missing type', () => {
    const invalidType: any = { ...baseOrder, type: 'STOP_LOSS' };
    const result = validateDemoOrder(invalidType);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Type must be MARKET or LIMIT');
  });

  it('should reject invalid status', () => {
    const invalidStatus: any = { ...baseOrder, status: 'DONE' };
    const result = validateDemoOrder(invalidStatus);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid order status');
  });

  it('should handle unparseable numbers', () => {
    const invalidNumbers: DemoOrder = {
      ...baseOrder,
      quantity: 'abc',
      type: 'LIMIT',
      price: 'def'
    };
    const result = validateDemoOrder(invalidNumbers);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Quantity must be a valid numeric string');
    expect(result.errors).toContain('Price must be a valid numeric string');
  });
});
