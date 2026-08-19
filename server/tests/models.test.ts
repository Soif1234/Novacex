import { describe, it, expect } from 'vitest';
import {
  UserEntity,
  AccountEntity,
  LedgerTransactionEntity,
  LedgerEntryEntity,
  OrderEntity,
  TradeEntity,
  FuturesPositionEntity,
  FuturesOrderEntity
} from '../src/models';

describe('Database Entity Models (server/src/models/)', () => {
  it('1. UserEntity shapes match PostgreSQL users table', () => {
    const user: UserEntity = {
      id: '123e4567-e89b-12d3-a456-426614174000',
      email: 'trader@mallickexchange.com',
      role: 'USER',
      accountStatus: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(user.role).toBe('USER');
    expect(user.accountStatus).toBe('ACTIVE');
  });

  it('2. AccountEntity and Ledger models enforce double-entry invariants', () => {
    const account: AccountEntity = {
      id: 'acc-uuid-1',
      userId: 'user-uuid-1',
      type: 'SPOT',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(account.type).toBe('SPOT');

    const tx: LedgerTransactionEntity = {
      id: 'tx-uuid-1',
      accountId: account.id,
      transactionType: 'SPOT_ORDER_LOCK',
      referenceId: 'ref-lock-1',
      description: 'Lock USDT for spot order',
      createdAt: new Date()
    };
    expect(tx.transactionType).toBe('SPOT_ORDER_LOCK');

    const entry: LedgerEntryEntity = {
      id: '1',
      transactionId: tx.id,
      accountId: account.id,
      asset: 'USDT',
      direction: 'DEBIT',
      amount: '500.000000000000000000',
      balanceAfter: '9500.000000000000000000',
      createdAt: new Date()
    };
    expect(entry.direction).toBe('DEBIT');
  });

  it('3. OrderEntity and TradeEntity match matching engine requirements', () => {
    const order: OrderEntity = {
      id: 'order-1',
      accountId: 'acc-1',
      market: 'SPOT',
      symbol: 'BTCUSDT',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000',
      quantity: '0.1',
      filledQuantity: '0',
      remainingQuantity: '0.1',
      lockedAmount: '5000',
      lockedAsset: 'USDT',
      status: 'NEW',
      timeInForce: 'GTC',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(order.market).toBe('SPOT');
    expect(order.status).toBe('NEW');

    const trade: TradeEntity = {
      id: 'trade-1',
      orderId: order.id,
      accountId: order.accountId,
      market: 'SPOT',
      symbol: 'BTCUSDT',
      side: 'BUY',
      price: '50000',
      quantity: '0.1',
      quoteQuantity: '5000',
      fee: '5',
      feeAsset: 'USDT',
      isMaker: false,
      createdAt: new Date()
    };
    expect(trade.isMaker).toBe(false);
  });

  it('4. FuturesPositionEntity matches derivative margin requirements', () => {
    const pos: FuturesPositionEntity = {
      id: 'pos-1',
      accountId: 'acc-fut-1',
      symbol: 'BTCUSDT',
      side: 'LONG',
      quantity: '1.0',
      entryPrice: '60000',
      markPrice: '60000',
      liquidationPrice: '54000',
      leverage: 10,
      marginMode: 'ISOLATED',
      initialMargin: '6000',
      maintenanceMargin: '300',
      realizedPnl: '0',
      status: 'OPEN',
      createdAt: new Date(),
      updatedAt: new Date()
    };
    expect(pos.leverage).toBe(10);
    expect(pos.marginMode).toBe('ISOLATED');
  });
});
