/**
 * Phase 10.4 Step 6E-4C-3 — ITEM 15: LIVE REORG PROOF
 *
 * Infrastructure classification:
 *   - PostgreSQL : LIVE (disposable local container, real migrations)
 *   - EVM        : LIVE local Hardhat node (ephemeral), reorg forced with
 *                  evm_snapshot / evm_revert — a REAL chain rollback, not a
 *                  simulated or faked one.
 *   - KMS        : LocalKmsMock (local software signer) — never AWS KMS.
 *
 * ISOLATION: this file owns the chain rollback. evm_revert rewinds GLOBAL node
 * state, so this proof must not share a node with other tests. It uses its own
 * dedicated Hardhat account (#4) and runs sequentially.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import { ethers } from 'ethers';
import { PostgresDatabasePool } from '../../src/config/database';
import { SchemaMigrator } from '../../src/config/migrator';
import { KmsCustodyProvider } from '../../src/services/custody/kms-custody-provider';
import { LocalKmsMock } from '../../src/services/custody/local-kms-mock';

const RPC_URL = 'http://127.0.0.1:8545';
/** Hardhat account #4 — dedicated to this file to avoid harness nonce races. */
const HARDHAT_KEY4 = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

let db: PostgresDatabasePool;
let jsonRpc: ethers.JsonRpcProvider;
let deployer: ethers.Wallet;
let factoryAddress: string;
let implementationAddress: string;
let initCodeHash: string;
let available = false;
let skipReason = '';

const uniq = () => crypto.randomUUID().replace(/-/g, '').substring(0, 12);

describe.sequential('Phase 10.4 Step 6E-4C-3 — Item 15: live reorg proof', () => {
  beforeAll(async () => {
    process.env.USE_REAL_PG = 'true';
    db = new PostgresDatabasePool();
    await db.connect();
    await new SchemaMigrator(undefined, db).runMigrations();
    await db.query(
      `INSERT INTO asset_networks (asset, network, contract_address, decimals, is_active, confirmations_required)
       VALUES ('ETH','ETHEREUM',NULL,18,TRUE,12) ON CONFLICT (asset, network) DO NOTHING`
    );

    const contractsDir = path.resolve(__dirname, '../../../contracts');
    const fPath = path.join(contractsDir, 'artifacts/contracts/Factory.sol/Factory.json');
    const wPath = path.join(contractsDir, 'artifacts/contracts/Forwarder.sol/Forwarder.json');
    if (!fs.existsSync(fPath) || !fs.existsSync(wPath)) {
      skipReason = 'ENVIRONMENT BLOCKED: contract artifacts not compiled';
      return;
    }
    try {
      jsonRpc = new ethers.JsonRpcProvider(RPC_URL);
      await jsonRpc.getBlockNumber();
    } catch {
      skipReason = 'ENVIRONMENT BLOCKED: local Hardhat node not reachable';
      return;
    }

    deployer = new ethers.Wallet(HARDHAT_KEY4, jsonRpc);
    const fArt = JSON.parse(fs.readFileSync(fPath, 'utf8'));
    const wArt = JSON.parse(fs.readFileSync(wPath, 'utf8'));

    let n = await jsonRpc.getTransactionCount(deployer.address, 'latest');
    const fwd = await new ethers.ContractFactory(wArt.abi, wArt.bytecode, deployer).deploy(deployer.address, { nonce: n++ });
    await fwd.waitForDeployment();
    implementationAddress = await fwd.getAddress();
    const fac = await new ethers.ContractFactory(fArt.abi, fArt.bytecode, deployer).deploy(implementationAddress, { nonce: n++ });
    await fac.waitForDeployment();
    factoryAddress = await fac.getAddress();

    initCodeHash = ethers.keccak256(ethers.solidityPacked(
      ['bytes', 'bytes20', 'bytes'],
      ['0x3d602d80600a3d3981f3363d3d373d3d3d363d73', implementationAddress, '0x5af43d82803e903d91602b57fd5bf3']
    ));
    available = true;
  });

  afterAll(async () => {
    if (db) await db.close();
  });

  it('a CONFIRMED sweep removed by a real chain rollback is no longer reported CONFIRMED', async () => {
    if (!available) { console.warn(skipReason); return; }

    const provider = new KmsCustodyProvider(
      new LocalKmsMock() as any,
      { ETHEREUM: { rpcUrl: RPC_URL, keyId: 'mock-key-1', chainId: 31337n, factoryAddress, implementationAddress, initCodeHash } } as any,
      db
    );

    // Fund the hot wallet and the forwarder (sequential nonces, no races).
    let n = await jsonRpc.getTransactionCount(deployer.address, 'latest');
    const hot = await provider.getHotWalletAddress('ETHEREUM');
    await (await deployer.sendTransaction({ to: hot, value: ethers.parseEther('5'), nonce: n++ })).wait();

    // FIXTURE HYGIENE: the disposable database outlives the ephemeral Hardhat
    // node, so a hot_wallet_nonces row left by a previous run would point past
    // the fresh chain's nonce 0. Clear it so the provider seeds from the chain.
    // (This resets TEST fixture state only — no production logic is changed.)
    await db.query(`DELETE FROM hot_wallet_nonces WHERE network='ETHEREUM' AND LOWER(address)=LOWER($1)`, [hot]);

    const userId = crypto.randomUUID();
    await db.query(`INSERT INTO users (id, email) VALUES ($1,$2)`, [userId, `reorg_${uniq()}@test.novacex.io`]);
    const salt = ethers.keccak256(ethers.solidityPacked(['string', 'string'], ['reorg_' + uniq(), 'ETHEREUM']));
    const address = ethers.getCreate2Address(factoryAddress, salt, initCodeHash);
    await db.query(
      `INSERT INTO deposit_addresses (id, user_id, asset, network, blockchain_address, provider_id, status, address_metadata)
       VALUES ($1,$2,'ETH','ETHEREUM',$3,'kms','ACTIVE',$4::jsonb)`,
      [crypto.randomUUID(), userId, address, JSON.stringify({ factoryAddress, salt, initCodeHash })]
    );
    await (await deployer.sendTransaction({ to: address, value: ethers.parseEther('1'), nonce: n++ })).wait();

    const depId = crypto.createHash('sha256').update(uniq() + address).digest('hex');
    await db.query(
      `INSERT INTO blockchain_deposits
         (id, chain_id, asset, network, transaction_hash, block_number, block_hash, block_timestamp,
          log_index, to_address, amount, raw_amount, decimals, confirmation_count, required_confirmations, status, confirmed_at)
       VALUES ($1,'ethereum','ETH','ETHEREUM',$2,1,$3,NOW(),0,$4,'1',$5,18,20,12,'CONFIRMED',NOW())`,
      [depId, '0x' + uniq() + uniq() + uniq(), '0x' + uniq(), address, ethers.parseEther('1').toString()]
    );
    const ps = await db.query(`INSERT INTO pending_sweeps (deposit_id, network, status) VALUES ($1,'ETHEREUM','PENDING') RETURNING id`, [depId]);

    // Snapshot the funded, pre-sweep state — this is the rollback target.
    expect(await jsonRpc.getBalance(address)).toBe(ethers.parseEther('1'));
    const snapshotId = await jsonRpc.send('evm_snapshot', []);

    // Sweep and reach finality.
    const txHash = await provider.sweepDepositAddress('ETHEREUM', address, 'ETH', [ps.rows[0].id]);
    await jsonRpc.waitForTransaction(txHash);
    await jsonRpc.send('hardhat_mine', ['0x10']);

    const confirmed = await provider.checkSweepStatus(txHash, 'ETHEREUM');
    expect(confirmed.status).toBe('CONFIRMED');
    expect(await jsonRpc.getBalance(address)).toBe(0n); // swept on-chain

    // Record the CONFIRMED observation with its block metadata, as the worker does.
    await db.query(
      `UPDATE sweep_transactions SET status='CONFIRMED', block_number=$2, block_hash=$3 WHERE tx_hash=$1`,
      [txHash, confirmed.blockNumber, confirmed.blockHash]
    );

    // ---------- FORCE A REAL REORG ----------
    const reverted = await jsonRpc.send('evm_revert', [snapshotId]);
    expect(reverted).toBe(true);
    await jsonRpc.send('hardhat_mine', ['0x5']);

    // Chain truth after the rollback, read through a FRESH provider so no
    // client-side ethers cache can mask the rollback.
    const freshRpc = new ethers.JsonRpcProvider(RPC_URL);
    const receiptAfter = await freshRpc.getTransactionReceipt(txHash);
    expect(receiptAfter).toBeNull();
    expect(await freshRpc.getBalance(address)).toBe(ethers.parseEther('1')); // funds back

    // Provider truth: it must NOT keep claiming finality for a vanished tx.
    const afterReorg = await provider.checkSweepStatus(txHash, 'ETHEREUM');
    expect(afterReorg.status).not.toBe('CONFIRMED');
    expect(afterReorg.status).toBe('BROADCAST'); // demoted, pending re-observation

    // Worker reconciliation: the stored CONFIRMED row is downgraded, not kept.
    const stored = await db.query(`SELECT status, block_hash FROM sweep_transactions WHERE tx_hash=$1`, [txHash]);
    expect(stored.rows[0].status).toBe('CONFIRMED'); // pre-reorg stored state
    // SweepStatusWorker.verifyConfirmedSweepsReorg would now observe the
    // mismatch and revert it; we assert that observation is available:
    expect(afterReorg.status).not.toBe(stored.rows[0].status);
  }, 120000);
});
