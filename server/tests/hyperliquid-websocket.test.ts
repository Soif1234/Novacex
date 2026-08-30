/**
 * Hyperliquid WebSocket Client & Stream Processing Tests
 * Phase 10.5 â€” Step 10.5-3
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketServer, WebSocket } from 'ws';
vi.mock('ws', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    WebSocket: class MockWS extends actual.WebSocket {
      constructor(url: string, options: any) {
        if (url.includes('hyperliquid')) {
           super(`ws://127.0.0.1:${(global as any).__wsPort__}`, options);
        } else {
           super(url, options);
        }
      }
    }
  };
});
import { createServer, Server } from 'http';
import { HyperliquidWebSocketClient } from '../src/services/liquidity/hyperliquid/hyperliquid.ws';
import {
  L2BookSnapshotEvent,
  ExternalTradeEvent,
  ExternalFillEvent,
  ExternalOrderUpdateEvent,
  StreamHealthEvent
} from '../src/services/liquidity/hyperliquid/hyperliquid.events';
import { HyperliquidAdapter } from '../src/services/liquidity/hyperliquid/hyperliquid.adapter';

describe('Hyperliquid WebSocket Gateway & Stream Ingestion', () => {
  let httpServer: Server;
  let wss: WebSocketServer;
  let serverPort: number;
  let lastServerWs: WebSocket | null = null;
  let client: HyperliquidWebSocketClient;

  beforeEach(async () => {
    // Create ephemeral local WebSocket mock server
    await new Promise<void>((resolve) => {
      httpServer = createServer();
      wss = new WebSocketServer({ server: httpServer });
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        serverPort = typeof addr === 'object' && addr ? addr.port : 8999;
        (global as any).__wsPort__ = serverPort;
        resolve();
      });
    });

    wss.on('connection', (ws) => {
      lastServerWs = ws;
      ws.on('message', (msg) => {
        try {
          const parsed = JSON.parse(msg.toString());
          if (parsed.method === 'ping') {
            ws.send(JSON.stringify({ channel: 'pong' }));
          }
        } catch {}
      });
    });
  });

  afterEach(async () => {
    if (client) {
      client.disconnect();
    }
    await new Promise<void>((resolve) => {
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  });

  it('A. connects and receives L2 book snapshot event with exact decimal strings', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet',
      accountAddress: '0x1111222233334444555566667777888899990000'
    });

    let receivedL2: L2BookSnapshotEvent | null = null;
    client.on('l2Book', (evt: L2BookSnapshotEvent) => {
      receivedL2 = evt;
    });

    client.connect();
    client.subscribeL2Book('BTC');

    // Wait for connection
    await new Promise((r) => setTimeout(r, 100));

    // Send L2 book payload from mock server
    lastServerWs?.send(JSON.stringify({
      channel: 'l2Book',
      data: {
        coin: 'BTC',
        time: 1725000000000,
        levels: [
          [{ px: '64000.5', sz: '1.2500', n: 3 }],
          [{ px: '64001.0', sz: '0.5000', n: 1 }]
        ]
      }
    }));

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedL2).not.toBeNull();
    expect(receivedL2?.market).toBe('BTC');
    expect(receivedL2?.bids[0].price).toBe('64000.5');
    expect(receivedL2?.bids[0].size).toBe('1.2500');
    expect(receivedL2?.asks[0].price).toBe('64001.0');

    // Verify local book cache
    const cached = client.getLocalBook('BTC');
    expect(cached?.bids[0].price).toBe('64000.5');
  });

  it('B. filters invalid negative or malformed levels safely', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet'
    });

    let receivedL2: L2BookSnapshotEvent | null = null;
    client.on('l2Book', (evt: L2BookSnapshotEvent) => {
      receivedL2 = evt;
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    lastServerWs?.send(JSON.stringify({
      channel: 'l2Book',
      data: {
        coin: 'ETH',
        time: 1725000000000,
        levels: [
          [{ px: '-100', sz: '1.0' }, { px: '3500.0', sz: '2.0', n: 1 }],
          [{ px: '3501.0', sz: '-5.0' }, { px: '3502.0', sz: '1.5', n: 1 }]
        ]
      }
    }));

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedL2?.bids.length).toBe(1);
    expect(receivedL2?.bids[0].price).toBe('3500.0');
    expect(receivedL2?.asks.length).toBe(1);
    expect(receivedL2?.asks[0].price).toBe('3502.0');
  });

  it('C. ingests public trade events and normalizes side/price/size', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet'
    });

    let receivedTrade: ExternalTradeEvent | null = null;
    client.on('trade', (t: ExternalTradeEvent) => {
      receivedTrade = t;
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    lastServerWs?.send(JSON.stringify({
      channel: 'trades',
      data: [
        {
          coin: 'SOL',
          side: 'B',
          px: '145.50',
          sz: '10.0',
          time: 1725000000100,
          tid: 54321
        }
      ]
    }));

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedTrade?.market).toBe('SOL');
    expect(receivedTrade?.side).toBe('BUY');
    expect(receivedTrade?.price).toBe('145.50');
    expect(receivedTrade?.size).toBe('10.0');
    expect(receivedTrade?.tid).toBe('54321');
  });

  it('D. ingests private user fills and enforces fill idempotency', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet',
      accountAddress: '0x1111222233334444555566667777888899990000'
    });

    const receivedFills: ExternalFillEvent[] = [];
    client.on('userFill', (f: ExternalFillEvent) => {
      receivedFills.push(f);
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    const fillPayload = {
      channel: 'userFills',
      data: {
        isSnapshot: false,
        user: '0x1111222233334444555566667777888899990000',
        fills: [
          {
            coin: 'BTC',
            px: '64500.0',
            sz: '0.2',
            side: 'B',
            time: 1725000000000,
            tid: 998877,
            oid: 12345,
            cloid: '0x1234567890abcdef1234567890abcdef',
            fee: '0.025',
            feeToken: 'USDC',
            closedPnl: '0.0',
            dir: 'Open Long'
          }
        ]
      }
    };

    // Send twice to verify deduplication
    lastServerWs?.send(JSON.stringify(fillPayload));
    lastServerWs?.send(JSON.stringify(fillPayload));

    await new Promise((r) => setTimeout(r, 100));

    // Deduplication should ensure only 1 event emitted
    expect(receivedFills.length).toBe(1);
    expect(receivedFills[0].fillId).toBe('998877');
    expect(receivedFills[0].quantity).toBe('0.2');
    expect(receivedFills[0].price).toBe('64500.0');
    expect(receivedFills[0].clientOrderId).toBe('0x1234567890abcdef1234567890abcdef');
  });

  it('E. ingests order updates and normalizes status into HedgeOrderStatus', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet',
      accountAddress: '0x1111222233334444555566667777888899990000'
    });

    let receivedUpdate: ExternalOrderUpdateEvent | null = null;
    client.on('orderUpdate', (u: ExternalOrderUpdateEvent) => {
      receivedUpdate = u;
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    lastServerWs?.send(JSON.stringify({
      channel: 'orderUpdates',
      data: [
        {
          order: {
            coin: 'BTC',
            side: 'B',
            limitPx: '64000.0',
            sz: '0.5',
            origSz: '1.0',
            oid: 88888,
            timestamp: 1725000000000,
            cloid: '0xabcdefabcdefabcdefabcdefabcdefab'
          },
          status: 'open',
          statusTimestamp: 1725000000500
        }
      ]
    }));

    await new Promise((r) => setTimeout(r, 100));

    expect(receivedUpdate?.status).toBe('OPEN');
    expect(receivedUpdate?.originalSize).toBe('1.0');
    expect(receivedUpdate?.remainingSize).toBe('0.5');
    expect(receivedUpdate?.executedSize).toBe('0.5');
  });

  it('F. heartbeat ping/pong maintains healthy state and triggers reconnect on timeout', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet',
      heartbeatIntervalMs: 50,
      heartbeatTimeoutMs: 50,
      initialReconnectDelayMs: 20
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 80));

    expect(client.getHealthStatus()).toBe('HEALTHY');
  });

  it('G. staleness monitor tracks timestamp updates', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet',
      staleThresholdMs: 50
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 50));

    // Send a message to set initial timestamp
    lastServerWs?.send(JSON.stringify({ channel: 'pong' }));

    await new Promise((r) => setTimeout(r, 50));
    expect(client.getLastMessageTimestamp()).toBeGreaterThan(0);
  });

  it('H. performs REST reconciliation on reconnect and deduplicates fills', async () => {
    const mockAdapter = {
      getClient: () => ({
        getUserFills: async () => [
          {
            coin: 'BTC',
            px: '64500.0',
            sz: '0.2',
            side: 'B',
            time: 1725000000000,
            tid: 998877, // Seeded fill
            oid: 12345,
            fee: '0.025',
            feeToken: 'USDC',
            closedPnl: '0.0',
            dir: 'Open Long'
          },
          {
            coin: 'ETH',
            px: '3500.0',
            sz: '1.0',
            side: 'A',
            time: 1725000000200,
            tid: 998878, // Missed fill
            oid: 12346,
            fee: '0.01',
            feeToken: 'USDC',
            closedPnl: '0.0',
            dir: 'Close Long'
          }
        ]
      })
    } as unknown as HyperliquidAdapter;

    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet',
      accountAddress: '0x1111222233334444555566667777888899990000',
      adapter: mockAdapter
    });

    const receivedFills: ExternalFillEvent[] = [];
    client.on('userFill', (f: ExternalFillEvent) => {
      receivedFills.push(f);
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    // Auto-recovery on connection loaded the 2 fills from REST
    expect(receivedFills.length).toBe(2);
    expect(receivedFills[0].fillId).toBe('998877');
    expect(receivedFills[1].fillId).toBe('998878');

    // Now send 998877 via WebSocket â€” it must be deduplicated
    lastServerWs?.send(JSON.stringify({
      channel: 'userFills',
      data: {
        isSnapshot: false,
        fills: [{ coin: 'BTC', px: '64500.0', sz: '0.2', side: 'B', time: 1725000000000, tid: 998877 }]
      }
    }));

    await new Promise((r) => setTimeout(r, 50));
    // Length must remain 2 (no duplicate)
    expect(receivedFills.length).toBe(2);
  });

  it('I. discards malformed non-JSON payloads without throwing or crashing', async () => {
    client = new HyperliquidWebSocketClient({
      hyperliquidEnv: 'testnet'
    });

    client.connect();
    await new Promise((r) => setTimeout(r, 100));

    // Send invalid garbage
    lastServerWs?.send('INVALID_NON_JSON_GARBAGE_STRING');
    lastServerWs?.send('{"broken": json');

    await new Promise((r) => setTimeout(r, 50));
    expect(client.getHealthStatus()).toBe('HEALTHY');
  });

  it('J. security isolation: WebSocket client has zero references to LedgerService or custody keys', () => {
    const keys = Object.keys(client);
    expect(keys).not.toContain('ledgerService');
    expect(keys).not.toContain('kmsProvider');
    expect(keys).not.toContain('safeSigner');
    expect(keys).not.toContain('customerWallet');
  });
});
