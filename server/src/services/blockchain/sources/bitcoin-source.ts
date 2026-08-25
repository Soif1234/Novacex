/**
 * Phase 9.4 — Bitcoin Blockchain Source
 *
 * Provider-neutral Bitcoin source. Reads on-chain data via a public API
 * (e.g. Mempool.space API, Blockstream API, or electrum) or a JSON-RPC
 * node.
 *
 * IMPORTANT:
 * - DISABLED unless an explicit API/RPC URL is configured.
 * - No provider credentials are stored in this file.
 * - The application must boot safely when no URL is present.
 * - Uses address-based transaction lookup (the dominant free-tier pattern).
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

export interface BitcoinSourceConfig {
  /** Base URL for the Bitcoin API (e.g. https://mempool.space/api or https://blockstream.info/api). */
  apiUrl: string | null;
  /** Timeout for each API call (ms). */
  requestTimeoutMs?: number;
}

interface MempoolBlock {
  id: string;
  height: number;
  version: number;
  timestamp: number;
  tx_count: number;
  size: number;
  weight: number;
  previousblockhash: string;
  merkle_root: string;
  nonce: number;
  bits: number;
  difficulty: number;
  extras?: Record<string, unknown>;
}

interface MempoolTransaction {
  txid: string;
  version: number;
  locktime: number;
  vin: Array<{
    txid: string;
    vout: number;
    is_coinbase: boolean;
    scriptsig: string;
    sequence: number;
    prevout?: {
      scriptpubkey_address: string;
      value: number;
    };
  }>;
  vout: Array<{
    scriptpubkey: string;
    scriptpubkey_asm: string;
    scriptpubkey_type: string;
    scriptpubkey_address: string;
    value: number;
  }>;
  size: number;
  weight: number;
  fee: number;
  status: {
    confirmed: boolean;
    block_height: number;
    block_hash: string;
    block_time: number;
  };
}

export class BitcoinSource implements IBlockchainSource {
  public readonly chainId = 'bitcoin';
  public readonly displayName = 'Bitcoin';
  private readonly apiUrl: string | null;
  private readonly timeoutMs: number;
  private latestHeight = 0;

  constructor(config: BitcoinSourceConfig) {
    this.apiUrl = config.apiUrl && config.apiUrl.trim().length > 0 ? config.apiUrl.trim().replace(/\/+$/, '') : null;
    this.timeoutMs = config.requestTimeoutMs ?? 15_000;
  }

  /** True when an API endpoint has been configured. */
  public get isConfigured(): boolean {
    return this.apiUrl !== null;
  }

  /** True when the source is not configured (safe boot with no network). */
  public get isDisabled(): boolean {
    return this.apiUrl === null;
  }

  public async getBlockNumber(): Promise<number> {
    const res = await this.apiGet('/blocks/tip/height');
    const height = parseInt(String(res).trim(), 10);
    this.latestHeight = isNaN(height) ? 0 : height;
    return this.latestHeight;
  }

  public async getBlock(blockNumber: number): Promise<BlockHeader | null> {
    const res = await this.apiGet(`/block-height/${blockNumber}`);
    if (!res) return null;
    const blockHash = String(res).trim();
    const block = await this.apiGet(`/block/${blockHash}`);
    if (!block) return null;
    const b = block as MempoolBlock;
    return {
      number: b.height,
      hash: b.id,
      parentHash: b.previousblockhash ?? '',
      timestamp: b.timestamp,
      rawPayload: b as unknown as Record<string, unknown>,
    };
  }

  public async getTransaction(txHash: string): Promise<TransactionData | null> {
    const tx = await this.apiGet(`/tx/${txHash}`) as MempoolTransaction | null;
    if (!tx) return null;
    const from =
      tx.vin.length > 0 && tx.vin[0].prevout
        ? tx.vin[0].prevout.scriptpubkey_address
        : tx.vin[0]?.is_coinbase
          ? 'coinbase'
          : '';
    const to = tx.vout.length > 0 ? tx.vout[0].scriptpubkey_address : '';
    const totalValue = tx.vout.reduce((sum, out) => sum + out.value, 0);
    return {
      hash: tx.txid,
      from,
      to,
      value: String(totalValue),
      blockNumber: tx.status.block_height ?? 0,
      blockHash: tx.status.block_hash ?? '',
      timestamp: tx.status.block_time ?? 0,
      input: '',
      rawPayload: tx as unknown as Record<string, unknown>,
    };
  }

  public async getLogs(_request: GetLogsRequest): Promise<LogEntry[]> {
    // Not applicable to Bitcoin — no event logs.
    return [];
  }

  public async getAddressTransactions(
    address: string,
    fromBlock: number,
    toBlock: number
  ): Promise<AddressTransaction[]> {
    const txs = await this.apiGet(`/address/${address}/txs`) as MempoolTransaction[];
    if (!Array.isArray(txs)) return [];

    const results: AddressTransaction[] = [];
    for (const tx of txs) {
      const blockHeight = tx.status.block_height ?? 0;
      if (blockHeight < fromBlock || blockHeight > toBlock) continue;

      tx.vout.forEach((output, idx) => {
        if (output.scriptpubkey_address?.toLowerCase() === address.toLowerCase()) {
          results.push({
            txHash: tx.txid,
            voutIndex: idx,
            blockNumber: blockHeight,
            blockHash: tx.status.block_hash ?? '',
            timestamp: tx.status.block_time ?? 0,
            from: tx.vin[0]?.prevout?.scriptpubkey_address ?? '',
            to: output.scriptpubkey_address,
            value: String(output.value),
            rawPayload: { txid: tx.txid, voutIndex: idx } as unknown as Record<string, unknown>,
          });
        }
      });
    }
    return results;
  }

  public async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const height = await this.getBlockNumber();
      return {
        healthy: true,
        currentBlockHeight: height,
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
  // HTTP transport
  // -------------------------------------------------------------------------

  private async apiGet(path: string): Promise<any> {
    if (!this.apiUrl) {
      throw new Error(
        `Bitcoin source is not configured — no API URL. ` +
        `Blockchain monitoring requires explicit configuration.`
      );
    }
    const url = `${this.apiUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`Bitcoin API HTTP ${response.status}: ${response.statusText}`);
      }
      const contentType = response.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        return await response.json();
      }
      return await response.text();
    } finally {
      clearTimeout(timer);
    }
  }
}