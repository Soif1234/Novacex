/**
 * Phase 9.4 — Ethereum Blockchain Source
 *
 * Provider-neutral Ethereum source. Reads on-chain data via a JSON-RPC
 * endpoint (e.g. Infura / Alchemy / local node).
 *
 * IMPORTANT:
 * - DISABLED unless an explicit RPC URL is configured.
 * - No provider credentials are stored in this file.
 * - The application must boot safely when no RPC URL is present.
 * - Never trust a token symbol — only asset_networks.contract_address
 *   identifies approved token contracts.
 */

import {
  IBlockchainSource,
  BlockHeader,
  TransactionData,
  LogEntry,
  AddressTransaction,
  GetLogsRequest,
  HealthCheckResult,
  ERC20_TRANSFER_EVENT_TOPIC,
} from '../types';

export interface EthereumSourceConfig {
  rpcUrl: string | null;
  /** Approximate block time in seconds (used for lag alerts). */
  averageBlockTimeSeconds?: number;
  /** Timeout for each RPC call (ms). */
  requestTimeoutMs?: number;
}

interface JsonRpcResponse {
  jsonrpc: string;
  id: number;
  result?: any;
  error?: { code: number; message: string };
}

/**
 * Parse a hex-encoded quantity (Ethereum JSON-RPC QUANTITY) to a number.
 */
export function hexToNumber(hex: string): number {
  if (typeof hex !== 'string') return 0;
  return parseInt(hex.replace(/^0x/, ''), 16) || 0;
}

/**
 * Parse a hex-encoded string (Ethereum JSON-RPC DATA) to a plain string.
 */
export function hexToString(hex: string): string {
  if (typeof hex !== 'string') return '';
  if (hex === '0x' || hex === '0X') return '';
  return hex.replace(/^0x/, '');
}

/**
 * Decode a raw hex value into a decimal string.
 */
export function hexToDecimalString(hex: string): string {
  if (typeof hex !== 'string') return '0';
  const cleaned = hex.replace(/^0[xX]/, '');
  if (!/^[0-9a-fA-F]+$/.test(cleaned)) return '0';
  const big = BigInt('0x' + cleaned);
  return big.toString(10);
}

export class EthereumSource implements IBlockchainSource {
  public readonly chainId = 'ethereum';
  public readonly displayName = 'Ethereum';
  private readonly rpcUrl: string | null;
  private readonly timeoutMs: number;
  private readonly averageBlockTimeSeconds: number;
  private requestId = 1;

  constructor(config: EthereumSourceConfig) {
    this.rpcUrl = config.rpcUrl && config.rpcUrl.trim().length > 0 ? config.rpcUrl.trim() : null;
    this.timeoutMs = config.requestTimeoutMs ?? 10_000;
    this.averageBlockTimeSeconds = config.averageBlockTimeSeconds ?? 12;
  }

  /** True when an RPC endpoint has been configured. */
  public get isConfigured(): boolean {
    return this.rpcUrl !== null;
  }

  /** True when the source is not configured (safe boot with no network). */
  public get isDisabled(): boolean {
    return this.rpcUrl === null;
  }

  public async getBlockNumber(): Promise<number> {
    const res = await this.rpc('eth_blockNumber', []);
    return hexToNumber(res.result);
  }

  public async getBlock(blockNumber: number): Promise<BlockHeader | null> {
    const res = await this.rpc('eth_getBlockByNumber', [
      `0x${blockNumber.toString(16)}`,
      false,
    ]);
    if (!res.result) return null;
    return {
      number: hexToNumber(res.result.number),
      hash: res.result.hash,
      parentHash: res.result.parentHash,
      timestamp: hexToNumber(res.result.timestamp),
      rawPayload: res.result as Record<string, unknown>,
    };
  }

  public async getTransaction(txHash: string): Promise<TransactionData | null> {
    const res = await this.rpc('eth_getTransactionByHash', [txHash]);
    if (!res.result) return null;
    return {
      hash: res.result.hash,
      from: res.result.from,
      to: res.result.to ?? null,
      value: hexToDecimalString(res.result.value ?? '0x0'),
      blockNumber: hexToNumber(res.result.blockNumber ?? '0x0'),
      blockHash: res.result.blockHash ?? '',
      timestamp: 0,
      input: res.result.input ?? '0x',
      rawPayload: res.result as Record<string, unknown>,
    };
  }

  public async getLogs(request: GetLogsRequest): Promise<LogEntry[]> {
    const filter: Record<string, unknown> = {
      fromBlock: `0x${request.fromBlock.toString(16)}`,
      toBlock: `0x${request.toBlock.toString(16)}`,
    };
    if (request.addresses && request.addresses.length > 0) {
      filter.address = request.addresses;
    }
    if (request.topics && request.topics.length > 0) {
      filter.topics = request.topics;
    } else {
      filter.topics = [[ERC20_TRANSFER_EVENT_TOPIC]];
    }
    const res = await this.rpc('eth_getLogs', [filter]);
    const logs = Array.isArray(res.result) ? res.result : [];
    return logs.map((log: any) => ({
      address: log.address,
      topics: log.topics ?? [],
      data: log.data ?? '0x',
      blockNumber: hexToNumber(log.blockNumber ?? '0x0'),
      blockHash: log.blockHash ?? '',
      transactionHash: log.transactionHash ?? '',
      logIndex: hexToNumber(log.logIndex ?? '0x0'),
      removed: Boolean(log.removed),
      rawPayload: log as Record<string, unknown>,
    }));
  }

  public async getAddressTransactions(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<AddressTransaction[]> {
    // Native ETH transfers are detected by fetching full blocks and
    // inspecting each transaction's `to` field (transactions do not emit
    // Transfer events, so eth_getLogs alone cannot see them).
    //
    // Read-only JSON-RPC: eth_getBlockByNumber with full transaction objects.
    const results: AddressTransaction[] = [];
    const addressLower = address.toLowerCase();

    for (let n = fromBlock; n <= toBlock; n++) {
      let block: any = null;
      try {
        const res = await this.rpc('eth_getBlockByNumber', [
          `0x${n.toString(16)}`,
          true, // full transaction objects
        ]);
        block = res.result ?? null;
      } catch (err: any) {
        // RPC timeout / failure: propagate so the monitor never advances
        // its checkpoint past an incompletely scanned block.
        throw new Error(
          `EthereumSource: failed to fetch block ${n} for address scan: ${err?.message || String(err)}`,
        );
      }

      if (!block || !Array.isArray(block.transactions)) {
        // Block not found (or malformed/missing transaction list) — safe
        // to skip: nothing to scan in this block.
        continue;
      }

      const blockHash = typeof block.hash === 'string' ? block.hash : '';
      const blockTimestamp = hexToNumber(block.timestamp);

      for (const tx of block.transactions) {
        if (!tx || typeof tx !== 'object') continue;
        // Contract creation transactions have to = null — never deposits.
        if (!tx.to) continue;
        // Case-normalize addresses (Ethereum addresses are case-insensitive
        // hex; EIP-55 checksums must not affect matching).
        if (String(tx.to).toLowerCase() !== addressLower) continue;
        // Decode value (QUANTITY hex) to an exact decimal string (wei).
        const value = hexToDecimalString(tx.value ?? '0x0');
        // Zero-value transfers are not deposit observations.
        if (value === '' || value === '0') continue;

          // MUST verify transaction success status (reverted native transfers are ignored)
          let receipt: any = null;
          try {
            const txHash = typeof tx.hash === 'string' ? tx.hash : '';
            const res = await this.rpc('eth_getTransactionReceipt', [txHash]);
            receipt = res.result ?? null;
          } catch (err: any) {
            throw new Error(`EthereumSource: failed to fetch receipt for tx ${tx.hash}: ${err?.message || String(err)}`);
          }

          if (!receipt || (receipt.status !== '0x1' && receipt.status !== 1)) {
            continue; // Reverted transaction
          }

          results.push({
          txHash: typeof tx.hash === 'string' ? tx.hash : '',
          voutIndex: 0,
          blockNumber: n,
          blockHash,
          timestamp: blockTimestamp,
          from: typeof tx.from === 'string' ? tx.from : '',
          to: tx.to,
          value,
          rawPayload: { tx: { ...tx }, voutIndex: 0 } as unknown as Record<string, unknown>,
        });
      }
    }

    return results;
  }

  public async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const res = await this.rpc('eth_blockNumber', []);
      return {
        healthy: true,
        currentBlockHeight: hexToNumber(res.result),
        latencyMs: Date.now() - start,
      };
    } catch (err: any) {
      return {
        healthy: false,
        currentBlockHeight: 0,
        latencyMs: Date.now() - start,
        error: err?.message || String(err),
      };
    }
  }

  // -------------------------------------------------------------------------
  // JSON-RPC transport
  // -------------------------------------------------------------------------

  private async rpc(method: string, params: unknown[]): Promise<JsonRpcResponse> {
    if (!this.rpcUrl) {
      throw new Error(
        `Ethereum source is not configured — no RPC URL. ` +
        `Blockchain monitoring requires explicit configuration.`
      );
    }
    const id = this.requestId++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method,
          params,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Ethereum RPC HTTP ${response.status}: ${response.statusText}`);
      }
      const json = (await response.json()) as JsonRpcResponse;
      if (json.error) {
        throw new Error(`Ethereum RPC error (${method}): ${json.error.message}`);
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}