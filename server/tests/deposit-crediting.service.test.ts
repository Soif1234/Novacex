import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import crypto from 'crypto';
import { db } from '../../server/src/config/database';
import { env } from '../../server/src/config/env';
import { DepositCreditingService } from '../../server/src/services/blockchain/deposit-crediting.service';
import { circuitBreakerService } from '../../server/src/services/system/circuit-breaker.service';

describe('DepositCreditingService', () => {
  let service: DepositCreditingService;

  beforeEach(async () => {
    (db as any).reset?.();
    await db.connect();
    env.DEPOSIT_CREDITING_ENABLED = true;
    service = new DepositCreditingService(db);

    // Seed User
    await db.query(
      `INSERT INTO users (id, email, password_hash, role, account_status) VALUES ($1, $2, $3, $4, $5)`,
      ['user-1', 'test@test.com', 'USER', 'ACTIVE']
    );

    // Seed Accounts
    await db.query(
      `INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)`,
      ['account-funding-1', 'user-1', 'FUNDING']
    );
    await db.query(
      `INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, $3)`,
      ['account-spot-1', 'user-1', 'SPOT']
    );

    // Seed Asset Network
    await db.query(
      `INSERT INTO asset_networks (asset, network, is_active, decimals) VALUES ($1, $2, $3, $4)`,
      ['USDT', 'ETHEREUM', true, 6]
    );

    // Seed Deposit Address
    await db.query(
      `INSERT INTO deposit_addresses (id, user_id, asset, network, provider_id, blockchain_address, status) 
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      ['da-1', 'user-1', 'USDT', 'ETHEREUM', 'prov-1', 'cust-1', 'paddr-1', '0x123', null, 'ACTIVE', null]
    );

    // Reset circuit breaker
    circuitBreakerService.resetCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. CONFIRMED deposit credits exactly once', async () => {
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      ['dep-1', 'ethereum', 'USDT', 'ETHEREUM', '0xhash', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );

    await service.processBacklog(50);

    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-1', 'ethereum', 'USDT', 'ETHEREUM', '0xhash', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(true);
    expect(depRes.rows[0].ledger_tx_id).toBeTruthy();

    const balRes = await db.query('SELECT available_balance FROM wallet_balances WHERE account_id = $1', ['account-funding-1']);
    expect(parseFloat(balRes.rows[0].available_balance)).toBe(100);
  });

  it('5. unconfirmed deposit ignored', async () => {
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      ['dep-2', 'ethereum', 'USDT', 'ETHEREUM', '0xhash2', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'DETECTED', new Date(), new Date(), null, null]
    );

    await service.processBacklog(50);

    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-2', 'ethereum', 'USDT', 'ETHEREUM', '0xhash2', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'DETECTED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(false);
  });

  it('8. deposit halt queues confirmed deposit', async () => {
    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      ['dep-3', 'ethereum', 'USDT', 'ETHEREUM', '0xhash3', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );

    await circuitBreakerService.halt({ mode: 'HALT_ALL', triggeredBy: 'admin', reason: 'test' });
    await service.processBacklog(50);

    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-3', 'ethereum', 'USDT', 'ETHEREUM', '0xhash3', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(false);
  });

  it('13. historical ROTATED address can credit', async () => {
    await db.query(
      `UPDATE deposit_addresses SET status = 'ROTATED' WHERE id = $1`,
      ['da-1', null]
    );

    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      ['dep-4', 'ethereum', 'USDT', 'ETHEREUM', '0xhash4', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );

    await service.processBacklog(50);

    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-4', 'ethereum', 'USDT', 'ETHEREUM', '0xhash4', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(true);
  });
  
  it('10. suspended user stays uncredited', async () => {
    await db.query(`UPDATE users SET account_status = 'SUSPENDED' WHERE id = $1`, ['user-1']);

    await db.query(
      `INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)`,
      ['dep-5', 'ethereum', 'USDT', 'ETHEREUM', '0xhash5', 100, '0xbl', new Date(), 0, '0xfrom', '0x456', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );

    await service.processBacklog(50);

    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-5', 'ethereum', 'USDT', 'ETHEREUM', '0xhash5', 100, '0xbl', new Date(), 0, '0xfrom', '0x456', '100', '100000000', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(false);
  });

  it('rejects zero amount', async () => {
    await db.query(
      'INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)',
      ['dep-z', 'ethereum', 'USDT', 'ETHEREUM', '0xz', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '0', '0', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );
    await service.processBacklog(50);
    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-z', 'ethereum', 'USDT', 'ETHEREUM', '0xz', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '0', '0', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(false);
  });

  it('rejects negative amount', async () => {
    await db.query(
      'INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)',
      ['dep-n', 'ethereum', 'USDT', 'ETHEREUM', '0xn', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '-100', '-100', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );
    await service.processBacklog(50);
    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-n', 'ethereum', 'USDT', 'ETHEREUM', '0xn', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '-100', '-100', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(false);
  });

  it('rejects malformed amount', async () => {
    await db.query(
      'INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)',
      ['dep-m', 'ethereum', 'USDT', 'ETHEREUM', '0xm', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100.0.0', '100', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );
    await service.processBacklog(50);
    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-m', 'ethereum', 'USDT', 'ETHEREUM', '0xm', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '100.0.0', '100', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(false);
  });

  it('accepts high-precision decimal amount', async () => {
    await db.query(
      'INSERT INTO blockchain_deposits (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp, log_index, from_address, to_address, amount, raw_amount, token_contract, decimals, confirmation_count, required_confirmations, status, detected_at, confirmed_at, reorged_at, raw_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22)',
      ['dep-hp', 'ethereum', 'USDT', 'ETHEREUM', '0xhp', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '0.000000000000000001', '1', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]
    );
    await service.processBacklog(50);
    const depRes = await db.query('SELECT * FROM blockchain_deposits WHERE id = $1', ['dep-hp', 'ethereum', 'USDT', 'ETHEREUM', '0xhp', 100, '0xbl', new Date(), 0, '0xfrom', '0x123', '0.000000000000000001', '1', '0xtoken', 6, 12, 12, 'CONFIRMED', new Date(), new Date(), null, null]);
    expect(depRes.rows[0].is_credited).toBe(true);
  });
});
