import { test, expect, vi } from 'vitest';
import crypto from 'crypto';
const uuidv4 = () => crypto.randomUUID();

vi.mock('../../src/services/treasury/safe-verification.service', () => ({
  safeVerificationService: {
    verifySafeOnChain: vi.fn(() => Promise.resolve(true))
  }
}));

import { db } from '../../src/config/database';
import { env } from '../../src/config/env';
import { ethers } from 'ethers';

// Force manual safe custody config BEFORE imports
process.env.CUSTODY_ENABLED = 'true';
process.env.CUSTODY_PROVIDER = 'manual_safe';
process.env.CUSTODY_HOT_WALLET_ADDRESS = '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95';
process.env.TREASURY_SAFE_ADDRESS_ETHEREUM = '0x0c90608af5A365139FCa9FA31E326b6394E8FA9B';
process.env.TREASURY_SAFE_CHAIN_ID_ETHEREUM = '11155111';
process.env.ETHEREUM_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';

(env as any).CUSTODY_ENABLED = true;
(env as any).CUSTODY_PROVIDER = 'manual_safe';
(env as any).CUSTODY_HOT_WALLET_ADDRESS = '0x13Fc38B11A3C610B4F8789a0AC532d12AaD8eD95';
(env as any).TREASURY_SAFE_ADDRESS_ETHEREUM = '0x0c90608af5A365139FCa9FA31E326b6394E8FA9B';
(env as any).TREASURY_SAFE_CHAIN_ID_ETHEREUM = '11155111';
(env as any).ETHEREUM_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
process.env.ETHEREUM_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';

const dummyWallet = ethers.Wallet.createRandom();
process.env.TREASURY_SAFE_OWNER_ADDRESS_ETHEREUM = dummyWallet.address;
(env as any).TREASURY_SAFE_OWNER_ADDRESS_ETHEREUM = dummyWallet.address;

test('Real Sepolia Treasury Validation', async () => {
  // Setup providers dynamically
  const { custodyService } = await import('../../src/services/custody/custody.service');
  (custodyService as any).enabled = true;
  const { ManualSafeCustodyProvider } = await import('../../src/services/custody/manual-safe-custody-provider');
  (custodyService as any).adapter = new ManualSafeCustodyProvider(db);

  const { treasuryManagerService } = await import('../../src/services/treasury/treasury-manager.service');
  const { treasuryMonitorWorker } = await import('../../src/workers/TreasuryMonitorWorker');

  const adminUserId = uuidv4();
  await db.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [adminUserId, `admin-${Date.now()}@example.com`]);

  console.log('--- DB STATE INIT ---');

  const { SchemaMigrator } = await import('../../src/config/migrator');
  await new SchemaMigrator(undefined, db).runMigrations();

  const intentId = uuidv4();
  const nonceRes = await db.query('SELECT admin_nonce FROM treasury_config WHERE network = $1', ['ETHEREUM']);
  const nonce = nonceRes.rowCount > 0 ? Number(nonceRes.rows[0].admin_nonce) : 0;
  if (nonceRes.rowCount === 0) {
    await db.query(`INSERT INTO treasury_config (network, admin_nonce) VALUES ('ETHEREUM', 0)`);
  }

  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const amount = '0.0002';

  const domain = {
    name: 'NovaCEX Treasury',
    version: '1',
    chainId: 11155111,
    verifyingContract: '0x0c90608af5A365139FCa9FA31E326b6394E8FA9B'
  };
  const types = {
    Consolidate: [
      { name: 'network', type: 'string' },
      { name: 'asset', type: 'string' },
      { name: 'amount', type: 'string' },
      { name: 'destination', type: 'address' },
      { name: 'intentId', type: 'string' },
      { name: 'nonce', type: 'uint256' },
      { name: 'expiry', type: 'uint256' }
    ]
  };
  const value = {
    network: 'ETHEREUM',
    asset: 'ETH',
    amount,
    destination: '0x0c90608af5A365139FCa9FA31E326b6394E8FA9B',
    intentId,
    nonce,
    expiry
  };

  const validSignature = await dummyWallet.signTypedData(domain, types, value);

  console.log('STEP 3-5: NEGATIVE AUTHORIZATION TESTS');
  // Expired
  const expiredExpiry = Math.floor(Date.now() / 1000) - 100;
  const expiredSignature = await dummyWallet.signTypedData(domain, types, { ...value, expiry: expiredExpiry });
  await expect(treasuryManagerService.consolidateToSafe('ETHEREUM', 'ETH', amount, adminUserId, expiredSignature, nonce, expiredExpiry, intentId)).rejects.toThrow(/expired/);
  // Wrong owner
  const wrongWallet = ethers.Wallet.createRandom();
  const wrongSignature = await wrongWallet.signTypedData(domain, types, value);
  await expect(treasuryManagerService.consolidateToSafe('ETHEREUM', 'ETH', amount, adminUserId, wrongSignature, nonce, expiry, intentId)).rejects.toThrow(/Invalid admin signature/);
  console.log('Negative tests passed.');

  console.log('STEP 2 & 4: CREATE TREASURY INTENT & VERIFY');
  const withdrawalRequest = await treasuryManagerService.consolidateToSafe(
    'ETHEREUM',
    'ETH',
    amount,
    adminUserId,
    validSignature,
    nonce,
    expiry,
    intentId
  );

  console.log('Intent created:', withdrawalRequest.clientWithdrawalId);
  const row = await db.query(`SELECT status FROM treasury_transactions WHERE client_withdrawal_id = $1`, [withdrawalRequest.clientWithdrawalId]);
  console.log('Intent status:', row.rows[0].status);
  expect(row.rows[0].status).toBe('READY_FOR_MANUAL_EXECUTION');

  // Verify exactly one nonce consumption (same intentId but wrong nonce)
  const reusedIntentSig = await dummyWallet.signTypedData(domain, types, { ...value, nonce });
  // Since intentId is already used, it should throw Intent ID already exists before nonce validation, or vice versa depending on execution order
  await expect(treasuryManagerService.consolidateToSafe('ETHEREUM', 'ETH', amount, adminUserId, reusedIntentSig, nonce, expiry, intentId)).rejects.toThrow(/already used/);

  // Verify replay protection intentId with valid new nonce
  const newNonce = nonce + 1;
  const newNonceReusedIntentSig = await dummyWallet.signTypedData(domain, types, { ...value, nonce: newNonce });
  await expect(treasuryManagerService.consolidateToSafe('ETHEREUM', 'ETH', amount, adminUserId, newNonceReusedIntentSig, newNonce, expiry, intentId)).rejects.toThrow(/already used/);

  console.log('STEP 8: MANUAL TREASURY CONFIRMATION');
  const realTxHash = '0x8ffd088a6e60fa355bd28b23bcd56f5fc5af48a2471bcf0155b5e716d3d6ecc8';

  await treasuryManagerService.confirmManualTreasuryTransfer(withdrawalRequest.clientWithdrawalId, realTxHash, adminUserId);
  const row2 = await db.query(`SELECT status, tx_hash FROM treasury_transactions WHERE client_withdrawal_id = $1`, [withdrawalRequest.clientWithdrawalId]);
  console.log('Confirmed Intent status:', row2.rows[0].status, row2.rows[0].tx_hash);
  expect(row2.rows[0].status).toBe('CONFIRMED');

  console.log('STEP 9: TREASURY MONITOR');
  // Running monitor directly
  await (treasuryMonitorWorker as any).run();

  // Verify no duplicates
  const finalRows = await db.query(`SELECT status, tx_hash FROM treasury_transactions WHERE tx_hash = $1`, [realTxHash]);
  console.log('Total DB rows for real tx_hash:', finalRows.rowCount);
  expect(finalRows.rowCount).toBe(1);

  console.log('ALL PROGRAMMATIC TESTS PASS.');
});
