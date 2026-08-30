import { IDatabaseConnection } from '../../config/database';
import { IBlockchainSource, ERC20_TRANSFER_EVENT_TOPIC, computeBlockchainEventId } from '../blockchain/types';
import { logger } from '../../config/logger';
import { TreasuryService, TreasuryConfig } from './treasury.service';
import { SafeVerificationService } from './safe-verification.service';
import { ethers } from 'ethers';

export class TreasuryMonitorService {
  private networkName: string;
  
  constructor(
    private readonly db: IDatabaseConnection,
    private readonly source: IBlockchainSource,
    private readonly treasuryService: TreasuryService,
    private readonly safeVerifier: SafeVerificationService
  ) {
    this.networkName = source.chainId.toUpperCase();
  }

  public async runOnce(rpcUrl: string): Promise<void> {
    const config = await this.treasuryService.getTreasuryConfig(this.networkName);
    if (!config) return;

    // Verify Safe configuration drift
    const isSafeValid = await this.safeVerifier.verifySafeOnChain(
      config.safeAddress,
      config.ownerAddress,
      config.threshold,
      rpcUrl
    );

    if (!isSafeValid) {
      await this.treasuryService.recordReconciliationEvent(
        this.networkName,
        { owner: config.ownerAddress, threshold: config.threshold },
        { status: 'INVALID_ON_CHAIN' },
        'Safe configuration drift detected. Halting treasury automation.'
      );
      logger.error('TreasuryMonitor: Safe on-chain verification failed. Halting.');
      return;
    }

    // In a real implementation, we would keep track of last scanned block in a table like `treasury_sync_status`.
    // For this implementation, we will just scan the latest block for demonstration or rely on idempotency.
    try {
      const latestBlock = await this.source.getBlockNumber();
      // Scan logic would go here:
      // 1. Fetch ERC20 logs where `topics[1]` (from) is config.safeAddress
      // 2. Fetch Native transactions
      // 3. Insert via this.treasuryService.insertTreasuryTransaction()
      
      // We'll simulate a scan success for now
    } catch (err: any) {
      logger.error(`TreasuryMonitor: RPC Failure: ${err.message}`);
      // Fall safe: Do nothing.
    }
  }
}
