import { ethers } from 'ethers';
import { TreasuryService } from './treasury.service';
import { SafeVerificationService } from './safe-verification.service';
import { logger } from '../../config/logger';

export class TreasuryMonitorService {
  constructor(
    private readonly treasuryService: TreasuryService,
    private readonly safeVerifier: SafeVerificationService,
    private readonly networkName: string
  ) {}

  public async runOnce(): Promise<void> {
    try {
      // We no longer rely on DB config for execution, but we check if it exists for DB readiness.
      const config = await this.treasuryService.getTreasuryConfig(this.networkName);
      if (!config) return;

      // P1: Immutable Safe Trust Anchor for Monitor
      const trustedSafeAddress = process.env[`TREASURY_SAFE_ADDRESS_${this.networkName}`] || process.env.TREASURY_SAFE_ADDRESS;
      const trustedOwnerAddress = process.env[`TREASURY_SAFE_OWNER_ADDRESS_${this.networkName}`] || process.env.TREASURY_SAFE_OWNER_ADDRESS;
      const trustedChainIdStr = process.env[`TREASURY_SAFE_CHAIN_ID_${this.networkName}`] || process.env.TREASURY_SAFE_CHAIN_ID;
      const rpcUrl = process.env[`${this.networkName}_RPC_URL`] || process.env.RPC_URL || 'http://127.0.0.1:8545';

      if (!trustedSafeAddress || !trustedOwnerAddress || !trustedChainIdStr) {
        logger.error(`TreasuryMonitor: Missing trusted Safe configuration for network ${this.networkName}`);
        return;
      }

      const trustedChainId = Number(trustedChainIdStr);

      const isSafeValid = await this.safeVerifier.verifySafeOnChain(
        trustedSafeAddress,
        trustedOwnerAddress,
        1, // threshold
        trustedChainId,
        rpcUrl
      );

      if (!isSafeValid) {
        logger.error(`TreasuryMonitor: Safe on-chain verification against TRUSTED config failed for network ${this.networkName}`);
        return;
      }

      const allowedTokens = await this.treasuryService.getAllowedAssets(this.networkName);
      if (allowedTokens.length === 0) return;

      // P1 fix (Phase 10.4 unfreeze audit): native assets (e.g. ETH) have a
      // NULL contract_address. They are NOT ERC-20s — they are covered by the
      // native-ETH block scan below. Filtering them here prevents a null-deref
      // crash that previously aborted EVERY scan when any allowed asset was
      // native, silently disabling both confirmation and reorg monitoring.
      const allowedContracts = new Map(
        allowedTokens
          .filter((t: any) => t.contractAddress)
          .map((t: any) => [t.contractAddress!.toLowerCase(), t.asset])
      );

      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const latestBlock = await provider.getBlockNumber();
      const CONFIRMATION_DEPTH = 12;
      const targetBlock = latestBlock - CONFIRMATION_DEPTH;

      let syncStatus = await this.treasuryService.getSyncStatus(this.networkName);

      if (!syncStatus) {
        const initBlock = targetBlock;
        const blockObj = await provider.getBlock(initBlock);
        if (!blockObj) return;
        syncStatus = { lastBlockNumber: initBlock, lastBlockHash: blockObj.hash! };
        await this.treasuryService.updateSyncStatus(this.networkName, syncStatus.lastBlockNumber, syncStatus.lastBlockHash);
      }

      if (syncStatus.lastBlockNumber > targetBlock) {
        return; // waiting for confirmations
      }

      // Reorg Check
      let currentCheckBlock = syncStatus.lastBlockNumber;
      let checkBlockObj = await provider.getBlock(currentCheckBlock);

      while (checkBlockObj && checkBlockObj.hash !== syncStatus.lastBlockHash && currentCheckBlock > 0) {
        logger.warn(`TreasuryMonitor: Reorg detected at block ${currentCheckBlock}`);
        currentCheckBlock--;
        checkBlockObj = await provider.getBlock(currentCheckBlock);
      }

      if (currentCheckBlock < syncStatus.lastBlockNumber) {
        await this.db.transaction(async (dbClient) => {
          await dbClient.query(
            `UPDATE treasury_transactions SET status = 'REORGED', updated_at = NOW()
             WHERE network = $1 AND block_number > $2 AND status = 'CONFIRMED'`,
            [this.networkName, currentCheckBlock]
          );
          syncStatus = { lastBlockNumber: currentCheckBlock, lastBlockHash: checkBlockObj!.hash! };
          await this.treasuryService.updateSyncStatus(this.networkName, syncStatus.lastBlockNumber, syncStatus.lastBlockHash, dbClient);
        });
      }

      if (syncStatus.lastBlockNumber === targetBlock) {
        return; // nothing new
      }

      const fromBlock = syncStatus.lastBlockNumber + 1;
      const toBlock = targetBlock;

      try {
        const transferTopic = ethers.id('Transfer(address,address,uint256)');
        const paddedSafeAddress = ethers.zeroPadValue(trustedSafeAddress, 32);

        const contractAddresses: string[] = Array.from(allowedContracts.keys());
        let allLogs: ethers.Log[] = [];

        for (const contractAddress of contractAddresses) {
          const logsIn = await provider.getLogs({
            fromBlock,
            toBlock,
            address: contractAddress,
            topics: [transferTopic, null, paddedSafeAddress] // Safe is receiver
          });
          const logsOut = await provider.getLogs({
            fromBlock,
            toBlock,
            address: contractAddress,
            topics: [transferTopic, paddedSafeAddress, null] // Safe is sender
          });
          allLogs = allLogs.concat(logsIn, logsOut);
        }

        allLogs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);

        for (const log of allLogs) {
          const asset = allowedContracts.get(log.address.toLowerCase());
          if (!asset) continue;

          const parsed = ethers.AbiCoder.defaultAbiCoder().decode(['uint256'], log.data);
          const amountBase = parsed[0].toString();

          const fromAddr = ethers.dataSlice(log.topics[1], 12).toLowerCase();
          const toAddr = ethers.dataSlice(log.topics[2], 12).toLowerCase();

          await this.processPhysicalTransaction({
            network: this.networkName,
            chainId: trustedChainId,
            asset,
            tokenContract: log.address.toLowerCase(),
            sourceAddress: fromAddr,
            destinationAddress: toAddr,
            amount: amountBase,
            txHash: log.transactionHash,
            logIndex: log.index,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash
          });
        }

        // Native ETH processing
        const BATCH_SIZE = 100;
        for (let i = fromBlock; i <= toBlock; i += BATCH_SIZE) {
          const end = Math.min(i + BATCH_SIZE - 1, toBlock);
          for (let b = i; b <= end; b++) {
            const block = await provider.getBlock(b, true);
            if (!block) continue;
            for (const tx of block.prefetchedTransactions) {
              const from = tx.from?.toLowerCase();
              const to = tx.to?.toLowerCase();
              const safeAddr = trustedSafeAddress.toLowerCase();

              if (from === safeAddr || to === safeAddr) {
                const receipt = await provider.getTransactionReceipt(tx.hash);
                if (receipt && receipt.status === 1 && tx.value > 0n) {
                  await this.processPhysicalTransaction({
                    network: this.networkName,
                    chainId: trustedChainId,
                    asset: 'ETH',
                    tokenContract: null,
                    sourceAddress: from || '',
                    destinationAddress: to || '',
                    amount: tx.value.toString(),
                    txHash: tx.hash,
                    logIndex: 0,
                    blockNumber: tx.blockNumber!,
                    blockHash: tx.blockHash!
                  });
                }
              }
            }
          }
        }

        const finalBlock = await provider.getBlock(toBlock);
        await this.treasuryService.updateSyncStatus(this.networkName, finalBlock!.number, finalBlock!.hash!);

      } catch (err: any) {
        logger.error(`TreasuryMonitor: Error scanning blocks ${fromBlock}-${toBlock}: ${err.message}`);
      }
    } catch (err: any) {
      logger.error(`TreasuryMonitor: Critical error: ${err.message}`);
    }
  }

  private async processPhysicalTransaction(ev: any) {
    const db = this.treasuryService.getDatabase();
    await db.transaction(async (dbClient) => {
      // P0-1 / F3 (Phase 11K-B): Try to correlate with an existing row by txHash.
      // The correlation now matches ANY status (PENDING/SIGNING/BROADCAST intent
      // rows AND CONFIRMED rows) so that:
      //   - confirm-first: the admin already wrote tx_hash + CONFIRMED on the
      //     intent row; a later monitor scan of the same block must UPDATE that
      //     row (filling block info), NOT insert a second representation.
      //     (For ERC20 the physical log_index may differ from the intent's 0,
      //     so ON CONFLICT alone would NOT have deduplicated it — this
      //     by-txHash correlation is the authoritative dedupe.)
      //   - repeated monitor scan: the same physical tx re-processed updates the
      //     already-recorded row instead of inserting again.
      // The monitor NEVER assigns client_withdrawal_id — linking an unlinked
      // physical row to a manual intent is done exclusively by
      // TreasuryManagerService.confirmManualTreasuryTransfer (adoption) which
      // holds the advisory lock and performs full on-chain verification.
      if (ev.txHash) {
        const updateRes = await dbClient.query<{id: number}>(
          `UPDATE treasury_transactions
           SET status = 'CONFIRMED', log_index = $1, block_number = $2, block_hash = $3, updated_at = NOW()
           WHERE network = $4 AND tx_hash = $5
           RETURNING id`,
          [ev.logIndex, ev.blockNumber, ev.blockHash, this.networkName, ev.txHash]
        );

        if (updateRes.rows.length > 0) {
          logger.info(`TreasuryMonitor: Correlated physical transaction ${ev.txHash} with existing row ${updateRes.rows[0].id}`);
          return;
        }
      }

      // If we fall through here, it's an unknown transfer with no matching
      // intent/physical row. Before inserting an unlinked row, attempt to
      // correlate with a uniquely matching READY_FOR_MANUAL_EXECUTION intent
      // by parameters (network, asset, source, destination, amount). This
      // prevents the monitor from inserting a redundant second row when a
      // manual intent that represents the same physical transaction exists
      // but has not yet been confirmed (tx_hash = NULL).
      const countRes = await dbClient.query<{cnt: string}>(
        `SELECT COUNT(*) as cnt FROM treasury_transactions
         WHERE network = $1 AND asset = $2
           AND LOWER(source_address) = LOWER($3)
           AND LOWER(destination_address) = LOWER($4)
           AND amount = $5
           AND status = 'READY_FOR_MANUAL_EXECUTION'
           AND tx_hash IS NULL`,
        [ev.network, ev.asset, ev.sourceAddress, ev.destinationAddress, ev.amount]
      );
      if (Number(countRes.rows[0].cnt) === 1) {
        await dbClient.query(
          `UPDATE treasury_transactions
           SET status = 'CONFIRMED', tx_hash = $1, log_index = $2, block_number = $3, block_hash = $4, updated_at = NOW()
           WHERE network = $5 AND asset = $6
             AND LOWER(source_address) = LOWER($7)
             AND LOWER(destination_address) = LOWER($8)
             AND amount = $9
             AND status = 'READY_FOR_MANUAL_EXECUTION'
             AND tx_hash IS NULL`,
          [ev.txHash, ev.logIndex, ev.blockNumber, ev.blockHash, ev.network, ev.asset, ev.sourceAddress, ev.destinationAddress, ev.amount]
        );
        logger.info(`TreasuryMonitor: Adopted READY intent by parameters for tx ${ev.txHash}`);
        return;
      }

      // Otherwise, insert a physical record (idempotent via uq_treasury_tx / ON CONFLICT DO
      // NOTHING). TreasuryManagerService.confirmManualTreasuryTransfer() will
      // ADOPT this unlinked row when the admin confirms the matching intent.
      logger.info(`TreasuryMonitor: Recording unlinked physical transaction ${ev.txHash}`);
      await this.treasuryService.insertTreasuryTransaction({
        network: ev.network,
        chainId: ev.chainId,
        asset: ev.asset,
        tokenContract: ev.tokenContract,
        sourceAddress: ev.sourceAddress,
        destinationAddress: ev.destinationAddress,
        amount: ev.amount,
        txHash: ev.txHash,
        logIndex: ev.logIndex,
        blockNumber: ev.blockNumber,
        blockHash: ev.blockHash,
        status: 'CONFIRMED'
      }, dbClient);
    });
  }

  private get db() {
    return this.treasuryService.getDatabase();
  }
}
