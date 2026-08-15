import { DemoOrder } from '../types/orders';
import { Decimal } from 'decimal.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateDemoOrder(order: Partial<DemoOrder>): ValidationResult {
  const errors: string[] = [];

  if (!order.id || typeof order.id !== 'string') {
    errors.push('Valid Order ID is required');
  }

  if (!order.accountId || typeof order.accountId !== 'string') {
    errors.push('Valid Account ID is required');
  }

  if (!order.symbol || typeof order.symbol !== 'string') {
    errors.push('Valid Symbol is required');
  }

  if (order.side !== 'BUY' && order.side !== 'SELL') {
    errors.push('Side must be BUY or SELL');
  }

  if (order.type !== 'MARKET' && order.type !== 'LIMIT') {
    errors.push('Type must be MARKET or LIMIT');
  }

  const validStatuses = ['PENDING', 'FILLED', 'CANCELLED', 'REJECTED'];
  if (!order.status || !validStatuses.includes(order.status)) {
    errors.push('Invalid order status');
  }

  try {
    if (!order.quantity) {
      errors.push('Quantity is required');
    } else {
      const qty = new Decimal(order.quantity);
      if (qty.lte(0)) {
        errors.push('Quantity must be strictly positive');
      }
    }
  } catch {
    errors.push('Quantity must be a valid numeric string');
  }

  if (order.type === 'LIMIT') {
    try {
      if (!order.price) {
        errors.push('Price is required for LIMIT orders');
      } else {
        const price = new Decimal(order.price);
        if (price.lte(0)) {
          errors.push('Price must be strictly positive');
        }
      }
    } catch {
      errors.push('Price must be a valid numeric string');
    }
  }

  if (!order.createdAt || typeof order.createdAt !== 'number') {
    errors.push('Valid created timestamp is required');
  }

  if (!order.updatedAt || typeof order.updatedAt !== 'number') {
    errors.push('Valid updated timestamp is required');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
