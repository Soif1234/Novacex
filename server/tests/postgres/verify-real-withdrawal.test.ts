import { test, expect } from 'vitest';
import crypto from 'crypto';
const uuidv4 = () => crypto.randomUUID();
import { db } from '../../src/config/database';
import { env } from '../../src/config/env';

// Force manual safe custody config BEFORE imports
(env as any).CUSTODY_ENABLED = true;
(env as any).CUSTODY_PROVIDER = 'manual_safe';
(env as any).CUSTODY_HOT_WALLET_ADDRESS = '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95';
(env as any).ETHEREUM_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
(env as any).CRYPTO_WITHDRAWALS_ENABLED = true;

test('Real Sepolia Withdrawal Finalization', async () => {
  // Setup manual_safe dynamically to force adapter initialization after env is modified
  const { custodyService } = await import('../../src/services/custody/custody.service');
  (custodyService as any).enabled = true;
  const { ManualSafeCustodyProvider } = await import('../../src/services/custody/manual-safe-custody-provider');
  (custodyService as any).adapter = new ManualSafeCustodyProvider(db);

  const { withdrawalStatusWorker } = await import('../../src/workers/WithdrawalStatusWorker');

  const adminUserId = uuidv4();
  const userId = uuidv4();
  const accountId = uuidv4();

  // Create user and account
  await db.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [userId, `test-${Date.now()}@example.com`]);
  await db.query(`INSERT INTO accounts (id, user_id, type) VALUES ($1, $2, 'FUNDING')`, [accountId, userId]);

  // Credit account with 1 ETH
  const { ledgerService } = await import('../../src/services/ledger/ledger.service');
  await ledgerService.credit(accountId, 'ETH', '1', 'DEPOSIT', 'dep_init', 'Test deposit');

  console.log('--- DB STATE INIT ---');

  const wId = uuidv4();
  const txHash = '0x745359a540a742c47408ced2762ce352a6aa3d6411acf7ad308a9653aea2ee21';

  // Cleanup old state
  await db.query(`DELETE FROM withdrawals WHERE tx_hash = $1`, [txHash]);

  await db.query(`
    INSERT INTO withdrawals (id, account_id, asset, network, amount, destination_address, status, crypto_status, tx_hash)
    VALUES ($1, $2, 'ETH', 'ETHEREUM', '0.0004', '0xf67683407d6dF319c941ed080eA1Cad579F10306', 'PENDING', 'SUBMITTED', $3)
  `, [wId, accountId, txHash]);

  // Also reserve the funds as they would be after request
  await ledgerService.reserve(accountId, 'ETH', '0.0004', 'WITHDRAWAL', wId, 'Withdrawal reservation');

  let w = (await db.query(`SELECT status, crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wId])).rows[0];
  console.log('2. State before worker processing:', w.status, w.crypto_status);

  console.log('3. WithdrawalStatusWorker processing...');
  await (withdrawalStatusWorker as any).execute();

  w = (await db.query(`SELECT status, crypto_status, tx_hash FROM withdrawals WHERE id = $1`, [wId])).rows[0];
  console.log('4. Final crypto_status:', w.crypto_status);
  console.log('5. Final withdrawal status:', w.status);
  console.log('11. Reconciliation against real tx:', w.tx_hash === txHash ? 'PASS' : 'FAIL');

  // Check balances
  const ethBalance = await ledgerService.getBalance(accountId, 'ETH');
  console.log('7. Available balance (1 - 0.0004):', ethBalance?.available);
  console.log('8. Locked balance:', ethBalance?.locked);

  // Ledger settlements
  const entries = await db.query(`SELECT * FROM ledger_entries WHERE account_id = $1 AND transaction_id IN (SELECT id FROM ledger_transactions WHERE transaction_type = 'WITHDRAWAL')`, [accountId]);
  console.log('6. Final ledger settlement rows:', entries.rowCount);
  console.log('9. Exactly-one settlement:', entries.rowCount === 2 ? 'PASS' : 'FAIL');

  // Repeat confirmation behavior
  console.log('10. No duplicate settlement processing (running worker again)...');
  await (withdrawalStatusWorker as any).execute();
  const entriesRepeat = await db.query(`SELECT * FROM ledger_entries WHERE account_id = $1 AND transaction_id IN (SELECT id FROM ledger_transactions WHERE transaction_type = 'WITHDRAWAL')`, [accountId]);
  console.log('10. No duplicate settlement:', entriesRepeat.rowCount === 2 ? 'PASS' : 'FAIL');
});
