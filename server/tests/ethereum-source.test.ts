/**
 * Phase 9.4 — EthereumSource: Real-Source Native ETH Detection Unit Tests
 *
 * Tests the REAL EthereumSource implementation against a mocked RPC
 * boundary (global fetch). No live blockchain calls are made.
 *
 * Scenarios:
 * 1. Native ETH transfer to a monitored address → detected
 * 2. Native ETH transfer to an unrelated address → ignored
 * 3. Zero-value ETH transfer → ignored
 * 4. Contract creation (to = null) → ignored
 * 5. Multiple ETH transfers in one block → all detected
 * 6. Duplicate scan of the same block → idempotent (same event)
 * 7. Malformed RPC block (missing transactions) → safe empty result
 * 8. RPC error → throws (monitor preserves checkpoint)
 * 9. Native ETH event fields are correct (wei value, no tokenContract)
 * 10. ERC-20 USDT/USDC detection still works (eth_getLogs path)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EthereumSource, hexToDecimalString, hexToNumber } from '../src/services/blockchain/sources/ethereum-source';
import { ERC20_TRANSFER_TOPIC } from '../src/services/blockchain/types';

// ---------------------------------------------------------------------------
// Mock RPC transport
// ---------------------------------------------------------------------------

interface MockRpcHandler {
  (method: string, params: unknown[]): unknown;
}

/**
 * Replace global fetch with an in-memory JSON-RPC server.
 * Returns the mock function for assertions (call counts etc.).
 */
function mockRpc(handler: MockRpcHandler): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (_url: unknown, init?: any) => {
    const body = JSON.parse(init?.body ?? '{}');
    let result: unknown;
    let error: { code: number; message: string } | undefined;
    try {
      result = handler(body.method, body.params);
    } catch (err: any) {
      error = { code: -32000, message: err?.message || String(err) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: body.id ?? 1,
        result: error ? undefined : (result ?? null),
        error,
      }),
    };
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

// ---------------------------------------------------------------------------
// Test block builders
// ---------------------------------------------------------------------------

const DEPOSIT_ADDR = '0x1234567890abcdef1234567890abcdef12345678';
const OTHER_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function tx(hash: string, to: string | null, valueHex: string, from = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'): Record<string, unknown> {
  return { hash, from, to, value: valueHex, input: '0x', gas: '0x5208' };
}

function block(number: number, transactions: Array<Record<string, unknown> | null>, timestamp = 1_700_000_000 + number * 12): Record<string, unknown> {
  return {
    number: `0x${number.toString(16)}`,
    hash: `0x${'ab'.repeat(32)}`,
    parentHash: `0x${'cd'.repeat(32)}`,
    timestamp: `0x${timestamp.toString(16)}`,
    transactions,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 9.4 — EthereumSource native ETH detection (real source, mocked RPC)', () => {
  let source: EthereumSource;

  beforeEach(() => {
    source = new EthereumSource({ rpcUrl: 'https://mock-rpc.example.com' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('1. Native ETH transfer to monitored deposit address is detected', async () => {
    mockRpc((method, params) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber' && params[1] === true) {
        return block(100, [
          tx('0xaa11', OTHER_ADDR, '0x1bc16d674ec80000'), // 2 ETH to other addr
          tx('0xaa22', DEPOSIT_ADDR, '0xde0b6b3a7640000'), // 1 ETH to deposit addr
        ]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(result).toHaveLength(1);
    expect(result[0].to.toLowerCase()).toBe(DEPOSIT_ADDR.toLowerCase());
    expect(result[0].value).toBe('1000000000000000000'); // exact wei, no float
    expect(result[0].txHash).toBe('0xaa22');
    expect(result[0].blockNumber).toBe(100);
    expect(result[0].blockHash).toBe('0x' + 'ab'.repeat(32));
  });

  it('2. Native ETH transfer to unrelated address is ignored', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return block(100, [tx('0xbb11', OTHER_ADDR, '0xde0b6b3a7640000')]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(result).toHaveLength(0);
  });

  it('3. Zero-value ETH transfer is ignored', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return block(100, [tx('0xcc11', DEPOSIT_ADDR, '0x0')]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(result).toHaveLength(0);
  });

  it('4. Contract creation transaction (to = null) is ignored safely', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return block(100, [
          tx('0xdd11', null, '0xde0b6b3a7640000'), // contract creation
          tx('0xdd22', DEPOSIT_ADDR, '0xde0b6b3a7640000'),
        ]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(result).toHaveLength(1);
    expect(result[0].txHash).toBe('0xdd22');
  });

  it('5. Multiple ETH transfers in one block to monitored address are all detected', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return block(100, [
          tx('0xee11', DEPOSIT_ADDR, '0xde0b6b3a7640000'),
          tx('0xee22', DEPOSIT_ADDR, '0x1bc16d674ec80000'),
        ]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.txHash).sort()).toEqual(['0xee11', '0xee22']);
    expect(result.map(r => r.value).sort()).toEqual([
      '1000000000000000000',
      '2000000000000000000',
    ]);
  });

  it('6. Duplicate scan of the same block is idempotent (same events, no dupes)', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return block(100, [tx('0xff11', DEPOSIT_ADDR, '0xde0b6b3a7640000')]);
      }
      return null;
    });

    const first = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    const second = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(1);
    expect(first[0].txHash).toBe(second[0].txHash);
    expect(first[0].value).toBe(second[0].value);
  });

  it('7. Malformed RPC block (missing transactions) is a safe empty result', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return { number: '0x64', hash: '0x' + 'ab'.repeat(32), timestamp: '0x1' }; // no transactions
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 100, 100);
    expect(result).toHaveLength(0);
  });

  it('8. RPC failure propagates (monitor preserves checkpoint)', async () => {
    mockRpc(() => {
      throw new Error('RPC timeout');
    });

    await expect(source.getAddressTransactions(DEPOSIT_ADDR, 100, 100)).rejects.toThrow(/failed to fetch block/);
  });

  it('9. Native ETH event fields are exact: wei value, no token contract', async () => {
    mockRpc((method) => {
      if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getTransactionReceipt') { return { status: '0x1' }; }
        if (method === 'eth_getBlockByNumber') {
        return block(101, [tx('0x1111', DEPOSIT_ADDR, '0x16345785d8a0000')]); // 0.1 ETH
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 101, 101);
    expect(result).toHaveLength(1);
    const e = result[0];
    expect(e.value).toBe('100000000000000000'); // 0.1 * 1e18, exact
    expect(e.from).toBe('0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
    expect(e.to.toLowerCase()).toBe(DEPOSIT_ADDR.toLowerCase());
    expect(e.voutIndex).toBe(0); // used as logIndex for idempotency
    expect(e.blockNumber).toBe(101);
    expect(e.rawPayload).toBeTruthy();
  });


  it('11. Reverted native transaction (receipt.status = 0x0) is safely ignored', async () => {
    mockRpc((method, params) => {
      if (method === 'eth_getTransactionReceipt') {
        return { status: '0x0' };
      }
      if (method === 'eth_getBlockByNumber') {
        return block(102, [tx('0xaa55', DEPOSIT_ADDR, '0xde0b6b3a7640000')]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 102, 102);
    expect(result).toHaveLength(0); // Ignored because receipt.status == 0x0
  });

  it('12. Missing receipt (receipt = null) safely ignores the transaction (or throws)', async () => {
    mockRpc((method, params) => {
      if (method === 'eth_getTransactionReceipt') {
        return null;
      }
      if (method === 'eth_getBlockByNumber') {
        return block(103, [tx('0xaa66', DEPOSIT_ADDR, '0xde0b6b3a7640000')]);
      }
      return null;
    });

    const result = await source.getAddressTransactions(DEPOSIT_ADDR, 103, 103);
    expect(result).toHaveLength(0); // Ignored because receipt is null
  });

  it('13. Failed receipt fetch throws and preserves checkpoint', async () => {
    mockRpc((method, params) => {
      if (method === 'eth_getTransactionReceipt') {
        throw new Error('RPC offline');
      }
      if (method === 'eth_getBlockByNumber') {
        return block(104, [tx('0xaa77', DEPOSIT_ADDR, '0xde0b6b3a7640000')]);
      }
      return null;
    });

    await expect(source.getAddressTransactions(DEPOSIT_ADDR, 104, 104)).rejects.toThrow(/failed to fetch receipt/);
  });

  it('10. ERC-20 USDT/USDC detection path (eth_getLogs) still works', async () => {
    const usdtContract = '0xdac17f958d2ee523a2206206994597c13d831ec7';
    mockRpc((method, params) => {
      if (method === 'eth_getLogs') {
        const [filter] = params as any[];
        // Only return logs whose address matches the filtered contract
        if (filter.address && filter.address.length > 0 && !filter.address.includes(usdtContract)) {
          return [];
        }
        return [
          {
            address: usdtContract,
            topics: [
              ERC20_TRANSFER_TOPIC,
              `0x${'0'.repeat(24)}1111111111111111111111111111111111111111`,
              `0x${'0'.repeat(24)}${DEPOSIT_ADDR.slice(2)}`,
            ],
            data: '0x' + '0'.repeat(63) + '1',
            blockNumber: '0x64',
            blockHash: '0x' + 'ab'.repeat(32),
            transactionHash: '0x' + 'cd'.repeat(32),
            logIndex: '0x0',
            removed: false,
          },
        ];
      }
      return null;
    });

    const logs = await source.getLogs({ fromBlock: 100, toBlock: 100 });
    expect(logs).toHaveLength(1);
    expect(logs[0].address.toLowerCase()).toBe(usdtContract);
    expect(logs[0].topics[0]).toBe(ERC20_TRANSFER_TOPIC);
  });

  it('hexToDecimalString: exact wei conversion, no floating point', () => {
    expect(hexToDecimalString('0xde0b6b3a7640000')).toBe('1000000000000000000');
    expect(hexToDecimalString('0x1bc16d674ec80000')).toBe('2000000000000000000');
    expect(hexToDecimalString('0x0')).toBe('0');
    expect(hexToDecimalString('0X1')).toBe('1'); // uppercase prefix handled
    expect(hexToNumber('0x64')).toBe(100);
  });

  it('Unconfigured source throws (disabled / safe boot)', async () => {
    const unconfigured = new EthereumSource({ rpcUrl: null });
    expect(unconfigured.isDisabled).toBe(true);
    await expect(unconfigured.getAddressTransactions(DEPOSIT_ADDR, 1, 1)).rejects.toThrow(/not configured/);
    await expect(unconfigured.getBlockNumber()).rejects.toThrow(/not configured/);
  });
});
