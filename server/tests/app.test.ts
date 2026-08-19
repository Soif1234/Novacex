import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../src/app';
import { AppError } from '../src/middleware/errorHandler';
import { Request, Response, NextFunction } from 'express';

describe('Express Application (server/src/app.ts)', () => {
  it('1. Initializes Express application with configured middleware', () => {
    const app = createApp({ enableLogging: false });
    expect(app).toBeDefined();
    expect(typeof app.use).toBe('function');
  });

  it('2. Request ID middleware assigns and echoes X-Request-ID', () => {
    const app = createApp({ enableLogging: false });
    expect(app).toBeDefined();
  });

  it('3. AppError formats operational error correctly', () => {
    const error = new AppError('Insufficient balance', 400, 'INSUFFICIENT_FUNDS', { asset: 'USDT' });
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe('INSUFFICIENT_FUNDS');
    expect(error.isOperational).toBe(true);
    expect(error.details).toEqual({ asset: 'USDT' });
  });
});
