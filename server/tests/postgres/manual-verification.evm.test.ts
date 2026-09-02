/**
 * Phase 11K — Manual Safe Mode: ON-CHAIN VERIFICATION (LIVE LOCAL EVM)
 *
 * Infrastructure: LIVE disposable local Hardhat node (http://127.0.0.1:8545,
 * chainId 31337). This suite drives the REAL ManualTxVerificationService
 * against REAL on-chain transactions, proving the verification matrix:
 *
 *   E. invalid tx hash
 *   F. wrong sender
 *   G. wrong destination
 *   H. wrong amount
 *   I. wrong chain (chainId mismatch)
 *   J. failed (reverted) receipt
 *   + native ETH value verification
 *   + ERC20 Transfer-event verification (allowlisted token)
 *
 * Uses the well-known Hardhat dev accounts (publicly known keys, local only).
 * No production funds, no mainnet, no production Safe.
 *
 * Nonce isolation: each test uses its OWN pre-funded Hardhat account and
 * manages an explicit local nonce counter (seeded from the chain) for every
 * broadcast, bypassing ethers' internal nonce cache entirely.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'crypto';
import { ethers, HDNodeWallet } from 'ethers';

const RPC_URL = 'http://127.0.0.1:8545';
const MNEMONIC = 'test test test test test test test test test test test junk';
const CHAIN_ID = 31337;

const account = (index: number) => ({
  wallet: HDNodeWallet.fromPhrase(MNEMONIC, '', `m/44'/60'/0'/0/${index}`),
});

// Must be set BEFORE the env module is first evaluated in this file's module
// registry so the verifier reads the local RPC + chainId.
process.env.ETHEREUM_RPC_URL = RPC_URL;
process.env.CUSTODY_CHAIN_ID = '31337';
process.env.CUSTODY_HOT_WALLET_ADDRESS = account(0).wallet.address;
process.env.NODE_ENV = 'test';

let verifier: any;
let provider: ethers.JsonRpcProvider;

async function loadMockTokenArtifact(): Promise<any> {
  const artifact = await import(
    `../../../contracts/artifacts/contracts/MockToken.sol/MockToken.json`
  );
  return artifact?.default ?? artifact;
}

/** A per-account broadcaster with explicit nonce + manual mining. */
function makeBroadcaster(index: number) {
  let nextNonce: number | null = null;
  const { wallet } = account(index);
  return {
    address: wallet.address,
    async nonce(): Promise<number> {
      if (nextNonce === null) nextNonce = await provider.getTransactionCount(wallet.address, 'latest');
      return nextNonce!;
    },
    async send(tx: ethers.TransactionRequest): Promise<ethers.TransactionReceipt | null> {
      const nonce = await this.nonce();
      nextNonce = nonce + 1;
      const signed = await wallet.signTransaction({
        ...tx,
        from: wallet.address,
        nonce,
        chainId: CHAIN_ID,
        type: 2,
        maxFeePerGas: ethers.parseUnits('10', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      });
      const sent = await provider.broadcastTransaction(signed);
      await provider.send('evm_mine', []);
      // getTransactionReceipt (not wait()) so a reverted receipt (status 0)
      // is returned instead of ethers throwing CALL_EXCEPTION.
      return await provider.getTransactionReceipt(sent.hash);
    },
    async deploy(abi: any[], bytecode: string, gasLimit: bigint = 3_000_000n): Promise<ethers.Contract> {
      const factory = new ethers.ContractFactory(abi, bytecode, wallet);
      const deployTx = await factory.getDeployTransaction();
      const nonce = await this.nonce();
      nextNonce = nonce + 1;
      const signed = await wallet.signTransaction({
        ...deployTx,
        from: wallet.address,
        nonce,
        chainId: CHAIN_ID,
        type: 2,
        gasLimit,
        maxFeePerGas: ethers.parseUnits('10', 'gwei'),
        maxPriorityFeePerGas: ethers.parseUnits('1', 'gwei'),
      });
      const sent = await provider.broadcastTransaction(signed);
      await provider.send('evm_mine', []);
      const receipt = await provider.getTransactionReceipt(sent.hash);
      if (!receipt || receipt.status !== 1) throw new Error('contract deployment failed');
      const address = ethers.getCreateAddress({ from: wallet.address, nonce });
      return new ethers.Contract(address, abi, wallet);
    },
  };
}

describe('Phase 11K — ManualTxVerificationService (live local EVM)', () => {
  beforeAll(async () => {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    await provider.getBlockNumber(); // throws if node unavailable
    // Manual mining: disable automine so reverted transactions are mined with
    // status 0 (automine rejects them outright, so a reverted receipt cannot
    // otherwise be produced).
    await provider.send('evm_setAutomine', [false]);
    // Fresh-import the verifier + env within this file's registry so it reads
    // the process.env values set above.
    const mod = await import('../../src/services/custody/manual-tx-verification.service');
    verifier = new mod.ManualTxVerificationService();

    // Connect the shared DB singleton so the ERC20 allowlist lookup
    // (asset_networks) can run against the real database.
    process.env.USE_REAL_PG = 'true';
    const { db } = await import('../../src/config/database');
    if ((db as any).connect) await (db as any).connect();
  });

  it('E. invalid tx hash format is rejected immediately', async () => {
    const res = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: '0x1234',
      expectedSender: account(0).wallet.address,
      expectedDestination: '0x' + '11'.repeat(20),
      asset: 'ETH',
      expectedAmount: '0.1',
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/hash/);
  });

  it('F/G/H. real ETH tx: correct -> verified; wrong sender/dest/amount -> rejected', async () => {
    const b = makeBroadcaster(1);
    const recipient = ethers.getAddress('0x' + '22'.repeat(20));
    const tx = await b.send({ to: recipient, value: ethers.parseEther('0.5'), gasLimit: 21000 });

    // Correct sender/dest/amount -> verified.
    const ok = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: tx!.hash!,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'ETH',
      expectedAmount: '0.5',
    });
    expect(ok.verified).toBe(true);

    // Wrong sender -> rejected.
    const wrongSender = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: tx!.hash!,
      expectedSender: account(2).wallet.address,
      expectedDestination: recipient,
      asset: 'ETH',
      expectedAmount: '0.5',
    });
    expect(wrongSender.verified).toBe(false);
    expect(wrongSender.reason).toMatch(/sender mismatch/i);

    // Wrong destination -> rejected.
    const wrongDest = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: tx!.hash!,
      expectedSender: b.address,
      expectedDestination: '0x' + '33'.repeat(20),
      asset: 'ETH',
      expectedAmount: '0.5',
    });
    expect(wrongDest.verified).toBe(false);
    expect(wrongDest.reason).toMatch(/destination mismatch/i);

    // Wrong amount (higher than sent) -> rejected.
    const wrongAmount = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: tx!.hash!,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'ETH',
      expectedAmount: '0.6',
    });
    expect(wrongAmount.verified).toBe(false);
    expect(wrongAmount.reason).toMatch(/amount below/i);
  });

  it('I. chainId mismatch is rejected (cross-chain replay protection)', async () => {
    const b = makeBroadcaster(3);
    const recipient = ethers.getAddress('0x' + '44'.repeat(20));
    const tx = await b.send({ to: recipient, value: ethers.parseEther('0.01'), gasLimit: 21000 });

    // Expected mainnet chainId=1 while the node reports 31337.
    const res = await verifier.verifyTreasuryTx(
      {
        network: 'ETHEREUM',
        txHash: tx!.hash!,
        expectedSender: b.address,
        expectedDestination: recipient,
        asset: 'ETH',
        expectedAmount: '0.01',
      },
      1
    );
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/chainId mismatch/i);
  });

  it('J. reverted receipt is rejected even when sender/dest/amount match', async () => {
    const b = makeBroadcaster(4);
    const artifact = await loadMockTokenArtifact();
    const token = await b.deploy(artifact.abi, artifact.bytecode);
    const tokenAddress = await token.getAddress();

    // Send plain ETH to a contract without receive(): it reverts on-chain and
    // is mined with status 0. Explicit gasLimit prevents estimateGas from
    // rejecting the tx before broadcast.
    const reverted = await b.send({ to: tokenAddress, value: ethers.parseEther('0.001'), gasLimit: 30000 });
    expect(reverted!.status).toBe(0); // revert confirmed

    const res = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: reverted!.hash!,
      expectedSender: b.address,
      expectedDestination: tokenAddress,
      asset: 'ETH',
      expectedAmount: '0.001',
    });
    expect(res.verified).toBe(false);
    expect(res.reason).toMatch(/reverted/i);
  });

  it('ERC20. allowlisted token Transfer event is verified (from/to/amount)', async () => {
    const b = makeBroadcaster(5);
    const recipient = ethers.getAddress('0x' + '55'.repeat(20));
    const artifact = await loadMockTokenArtifact();
    const token = await b.deploy(artifact.abi, artifact.bytecode);
    const tokenAddress = await token.getAddress();

    // Register the token as allowlisted (asset_networks) so verification accepts it.
    const { db } = await import('../../src/config/database');
    await db.query(
      `INSERT INTO asset_networks (asset, network, contract_address, decimals, is_active, confirmations_required)
       VALUES ('USDT', 'ETHEREUM', $1, 18, TRUE, 12)
       ON CONFLICT (asset, network) DO UPDATE SET contract_address = EXCLUDED.contract_address, decimals = EXCLUDED.decimals`,
      [tokenAddress]
    );

    // Mint USDT to the sender (account #5) so the transfer below succeeds.
    const mintTx = await b.send({
      to: tokenAddress,
      gasLimit: 200000,
      data: token.interface.encodeFunctionData('mint', [b.address, ethers.parseEther('1000')]),
    });
    expect(mintTx!.status).toBe(1);

    // Transfer from sender to recipient.
    const amount = ethers.parseEther('5');
    const transferTx = await b.send({
      to: tokenAddress,
      gasLimit: 200000,
      data: token.interface.encodeFunctionData('transfer', [recipient, amount]),
    });
    expect(transferTx!.status).toBe(1);

    // Correct asset/from/to/amount -> verified.
    const ok = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: transferTx!.hash!,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'USDT',
      expectedAmount: '5',
    });
    expect(ok.verified).toBe(true);

    // Wrong amount -> rejected.
    const wrongAmount = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: transferTx!.hash!,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'USDT',
      expectedAmount: '6',
    });
    expect(wrongAmount.verified).toBe(false);

    // Unallowlisted asset -> rejected.
    const unallowlisted = await verifier.verifyWithdrawalTx({
      network: 'ETHEREUM',
      txHash: transferTx!.hash!,
      expectedSender: b.address,
      expectedDestination: recipient,
      asset: 'NOTREAL',
      expectedAmount: '5',
    });
    expect(unallowlisted.verified).toBe(false);
    expect(unallowlisted.reason).toMatch(/not allowlisted/i);
  });
});

// Keep crypto import referenced (used for unique addresses if needed).
void crypto;
