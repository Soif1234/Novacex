/**
 * Phase 9.4 — Mock Blockchain Source
 *
 * Deterministic in-memory blockchain source for automated tests.
 * No network access. All Phase 9.4 tests use this source.
 */

import {
  IBlockchainSource,
  BlockHeader,
  TransactionData,
  LogEntry,
  AddressTransaction,
  GetLogsRequest,
  HealthCheckResult,
} from '../types';

export interface MockBlockData {
  number: number;
  hash: string;
  parentHash: string;
  timestamp: number;
  transactions: MockMockTransaction[];
  logs: MockMockLog[];
}

export interface MockMockTransaction {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  input: string;
  vout?: Array<{ value: number; scriptPubKey: { addresses: string[] } }>;
}

export interface MockMockLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: number;
  from?: string;
  to?: string;
  amount?: string;
}

export class MockBlockchainSource implements IBlockchainSource {
  public readonly chainId: string;
  public readonly displayName: string;
  private blocks: Map<number, MockBlockData> = new Map();
  private height = 0;
  private unhealthy = false;
  private errorAfter = 0;      // 0 = never fail; N = fail the next N calls
  private errorCount = 0;
  private callCount = 0;
  private forcedLatencyMs = 0;
  private healthCurrentBlockHeight = 0;

  constructor(chainId: 'ethereum' | 'bitcoin' = 'ethereum') {
    this.chainId = chainId;
    this.displayName = `Mock ${chainId === 'ethereum' ? 'Ethereum' : 'Bitcoin'} source`;
  }

  // -------------------------------------------------------------------------
  // Injection helpers (test-only)
  // -------------------------------------------------------------------------

  /** Inject a block into the mock chain. Deterministic hash if not provided. */
  public injectBlock(data: Partial<MockBlockData> & { number: number }): MockBlockData {
    const number = data.number;
    const hash =
      data.hash ||
      `0xmockblockhash${number.toString(16).padStart(64, '0')}`;
    const parentHash =
      data.parentHash ||
      (number > 0
        ? this.blocks.get(number - 1)?.hash ||
          `0xmockblockhash${(number - 1).toString(16).padStart(64, '0')}`
        : `0x0000000000000000000000000000000000000000000000000000000000000000`);
    const block: MockBlockData = {
      number,
      hash,
      parentHash,
      timestamp: data.timestamp ?? 1_700_000_000 + number * 12,
      transactions: data.transactions ?? [],
      logs: data.logs ?? [],
    };
    this.blocks.set(number, block);
    if (number > this.height) this.height = number;
    return block;
  }

  /** Set the next block number the source reports as current height. */
  public setNextBlock(height: number): void {
    this.height = height;
    this.healthCurrentBlockHeight = height;
  }

  /** Simulate a reorg: replace blocks at a given depth with new hashes. */
  public injectReorg(fromBlock: number, toBlock: number): void {
    for (let n = fromBlock; n <= toBlock; n++) {
      const existing = this.blocks.get(n);
      if (!existing) continue;
      existing.hash = `0xREORGED${n.toString(16).padStart(56, '0')}`;
      this.blocks.set(n, existing);
    }
  }

  /** Force the source to report unhealthy. */
  public setUnhealthy(unhealthy: boolean): void {
    this.unhealthy = unhealthy;
  }

  /** Make the next N calls fail with an error. */
  public failNextCalls(count: number): void {
    this.errorAfter = count;
    this.errorCount = 0;
  }

  /** Set artificial latency in ms. */
  public setLatency(ms: number): void {
    this.forcedLatencyMs = ms;
  }

  public getBlockCount(): number {
    return this.blocks.size;
  }

  public getLatestBlock(): MockBlockData | null {
    return this.blocks.get(this.height) ?? null;
  }

  // -------------------------------------------------------------------------
  // IBlockchainSource implementation
  // -------------------------------------------------------------------------

  public async getBlockNumber(): Promise<number> {
    await this.maybeFail();
    return this.height;
  }

  public async getBlock(blockNumber: number): Promise<BlockHeader | null> {
    await this.maybeFail();
    const block = this.blocks.get(blockNumber);
    if (!block) return null;
    return {
      number: block.number,
      hash: block.hash,
      parentHash: block.parentHash,
      timestamp: block.timestamp,
      rawPayload: { ...block } as unknown as Record<string, unknown>,
    };
  }

  public async getTransaction(txHash: string): Promise<TransactionData | null> {
    await this.maybeFail();
    for (const block of this.blocks.values()) {
      for (const tx of block.transactions) {
        if (tx.hash === txHash) {
          return {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            value: tx.value,
            blockNumber: block.number,
            blockHash: block.hash,
            timestamp: block.timestamp,
            input: tx.input ?? '0x',
            rawPayload: { ...tx } as unknown as Record<string, unknown>,
          };
        }
      }
    }
    return null;
  }

  public async getLogs(request: GetLogsRequest): Promise<LogEntry[]> {
    await this.maybeFail();
    const result: LogEntry[] = [];
    for (let n = request.fromBlock; n <= request.toBlock; n++) {
      const block = this.blocks.get(n);
      if (!block) continue;
      for (const log of block.logs) {
        if (request.addresses && request.addresses.length > 0) {
          const addrLower = log.address.toLowerCase();
          if (!request.addresses.some(a => a.toLowerCase() === addrLower)) continue;
        }
        if (request.topics && request.topics.length > 0) {
          const topic0 = log.topics[0]?.toLowerCase();
          const firstFilter = request.topics[0];
          if (firstFilter && firstFilter.length > 0) {
            const sig = firstFilter[0]?.toLowerCase();
            if (sig && topic0 !== sig) continue;
          }
        }
        result.push({
          address: log.address,
          topics: log.topics,
          data: log.data,
          blockNumber: n,
          blockHash: block.hash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
          removed: false,
          rawPayload: { ...log } as unknown as Record<string, unknown>,
        });
      }
    }
    return result;
  }

  public async getAddressTransactions(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<AddressTransaction[]> {
    await this.maybeFail();
    const result: AddressTransaction[] = [];
    const addressLower = address.toLowerCase();
    for (let n = fromBlock; n <= toBlock; n++) {
      const block = this.blocks.get(n);
      if (!block) continue;
      for (const tx of block.transactions) {
        if (this.chainId === 'ethereum') {
          // Ethereum-style: native ETH transfer detected when tx.to matches
          if (tx.to && tx.to.toLowerCase() === addressLower) {
            result.push({
              txHash: tx.hash,
              voutIndex: 0,
              blockNumber: n,
              blockHash: block.hash,
              timestamp: block.timestamp,
              from: tx.from,
              to: tx.to,
              value: tx.value,
              rawPayload: { tx: { ...tx }, voutIndex: 0 } as unknown as Record<string, unknown>,
            });
          }
          continue;
        }
        // Bitcoin-style: scan vout outputs
        const outputs = tx.vout ?? [];
        outputs.forEach((output, idx) => {
          const addrs = output.scriptPubKey?.addresses ?? [];
          if (addrs.some(a => a.toLowerCase() === addressLower)) {
            result.push({
              txHash: tx.hash,
              voutIndex: idx,
              blockNumber: n,
              blockHash: block.hash,
              timestamp: block.timestamp,
              from: tx.from,
              to: addrs[0] ?? '',
              value: String(output.value),
              rawPayload: { tx: { ...tx }, voutIndex: idx } as unknown as Record<string, unknown>,
            });
          }
        });
      }
    }
    return result;
  }

  public async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    if (this.unhealthy) {
      return {
        healthy: false,
        currentBlockHeight: this.height,
        latencyMs: Date.now() - start,
        error: 'mock source unhealthy',
      };
    }
    return {
      healthy: true,
      currentBlockHeight: this.height,
      latencyMs: Date.now() - start,
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async maybeFail(): Promise<void> {
    this.callCount++;
    if (this.forcedLatencyMs > 0) {
      await new Promise(resolve => setTimeout(resolve, this.forcedLatencyMs));
    }
    if (this.unhealthy) {
      throw new Error('Mock blockchain source is unhealthy (simulated outage)');
    }
    if (this.errorAfter > 0) {
      this.errorCount++;
      if (this.errorCount <= this.errorAfter) {
        throw new Error('Mock blockchain source failed (simulated error)');
      }
      this.errorAfter = 0;
      this.errorCount = 0;
    }
  }
}