import { ethers } from 'ethers';
import { logger } from '../../config/logger';

// Minimal ABI for Safe verification
const SAFE_ABI = [
  'function getOwners() public view returns (address[])',
  'function getThreshold() public view returns (uint256)'
];

export class SafeVerificationService {
  /**
   * Verifies that the deployed Safe contract matches our configured expectations.
   * Fails closed if anything is mismatched or unreachable.
   */
  public async verifySafeOnChain(
    safeAddress: string,
    expectedOwner: string,
    expectedThreshold: number,
    rpcUrl: string
  ): Promise<boolean> {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      
      // 1. Check if contract exists
      const code = await provider.getCode(safeAddress);
      if (code === '0x') {
        logger.error(`SafeVerification: No contract code at ${safeAddress}`);
        return false;
      }

      // 2. Fetch Safe state
      const safeContract = new ethers.Contract(safeAddress, SAFE_ABI, provider);
      
      const owners: string[] = await safeContract.getOwners();
      const threshold: bigint = await safeContract.getThreshold();

      // 3. Verify exactly 1 owner
      if (owners.length !== 1) {
        logger.error(`SafeVerification: Expected 1 owner, found ${owners.length}`);
        return false;
      }

      // 4. Verify owner identity
      const actualOwner = owners[0].toLowerCase();
      if (actualOwner !== expectedOwner.toLowerCase()) {
        logger.error(`SafeVerification: Owner mismatch. Expected ${expectedOwner}, found ${actualOwner}`);
        return false;
      }

      // 5. Verify threshold is exactly 1
      if (Number(threshold) !== expectedThreshold || expectedThreshold !== 1) {
        logger.error(`SafeVerification: Threshold mismatch or not 1. Found ${threshold.toString()}`);
        return false;
      }

      return true;
    } catch (err: any) {
      logger.error(`SafeVerification: Error verifying Safe on chain: ${err.message}`);
      return false; // Fail closed
    }
  }
}
