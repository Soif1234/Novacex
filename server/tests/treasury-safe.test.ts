import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { SafeVerificationService } from '../src/services/treasury/safe-verification.service';
import fs from 'fs';
import path from 'path';

describe('Phase 10.6 Treasury - Safe Configuration & Verification', () => {
  let safeAddress: string;
  let ownerAddress: string;
  const RPC_URL = 'http://127.0.0.1:8545';
  let verifier: SafeVerificationService;

  beforeAll(() => {
    verifier = new SafeVerificationService();
    // Read the deployed contract data from scratch/hardhat/deployed.json
    try {
      const deployedData = JSON.parse(
        fs.readFileSync(path.join(__dirname, '../scratch/hardhat/deployed.json'), 'utf8')
      );
      safeAddress = deployedData.safeAddress;
      ownerAddress = deployedData.ownerAddress;
    } catch (err) {
      console.error('Test blocked: Ensure ganache is running and deploy.js has been executed.');
      throw err;
    }
  });

  it('A. correct owner & threshold -> should verify successfully', async () => {
    const isValid = await verifier.verifySafeOnChain(safeAddress, ownerAddress, 1, 1337, RPC_URL);
    expect(isValid).toBe(true);
  });

  it('B. wrong owner -> should fail closed', async () => {
    const wrongOwner = '0x1234567890123456789012345678901234567890';
    const isValid = await verifier.verifySafeOnChain(safeAddress, wrongOwner, 1, 1337, RPC_URL);
    expect(isValid).toBe(false);
  });

  it('C. threshold drift (checking against threshold 2 instead of 1) -> should fail closed', async () => {
    const isValid = await verifier.verifySafeOnChain(safeAddress, ownerAddress, 2, 1337, RPC_URL);
    expect(isValid).toBe(false);
  });

  it('D. wrong Safe address (EOA/no code) -> should fail closed', async () => {
    // We use the owner address itself, which is an EOA without code
    const isValid = await verifier.verifySafeOnChain(ownerAddress, ownerAddress, 1, 1337, RPC_URL);
    expect(isValid).toBe(false);
  });

  it('E. chain isolation (RPC failure) -> should fail safe', async () => {
    const isValid = await verifier.verifySafeOnChain(safeAddress, ownerAddress, 1, 1337, 'http://127.0.0.1:9999');
    expect(isValid).toBe(false);
  });

  it('F. chainId mismatch (1 vs 1337) -> should fail closed', async () => {
    const isValid = await verifier.verifySafeOnChain(safeAddress, ownerAddress, 1, 1, RPC_URL);
    expect(isValid).toBe(false);
  });
});
