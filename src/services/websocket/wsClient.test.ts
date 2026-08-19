import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketClient } from './wsClient';

class MockWebSocket {
  public static instances: MockWebSocket[] = [];
  public readyState: number = 0; // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
  public url: string;
  public onopen: (() => void) | null = null;
  public onmessage: ((event: any) => void) | null = null;
  public onclose: (() => void) | null = null;
  public onerror: ((err: any) => void) | null = null;
  public sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = 1; // OPEN
      if (this.onopen) this.onopen();
    }, 10);
  }

  public send(data: string) {
    this.sentMessages.push(data);
  }

  public close() {
    this.readyState = 3;
    if (this.onclose) this.onclose();
  }

  public simulateMessage(data: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }
}

describe('WebSocketClient (src/services/websocket/wsClient.ts)', () => {
  let originalWs: any;

  beforeEach(() => {
    MockWebSocket.instances = [];
    originalWs = (global as any).WebSocket;
    (global as any).WebSocket = MockWebSocket;
    (MockWebSocket as any).OPEN = 1;
    (MockWebSocket as any).CONNECTING = 0;
  });

  afterEach(() => {
    (global as any).WebSocket = originalWs;
    vi.restoreAllMocks();
  });

  it('1. connects and sends subscribe frame on channel subscription', async () => {
    const client = new WebSocketClient('ws://localhost:4000/ws');
    const callback = vi.fn();

    const unsub = client.subscribe('ticker:BTCUSDT', callback);

    await new Promise(r => setTimeout(r, 20));

    expect(MockWebSocket.instances.length).toBe(1);
    const mockWs = MockWebSocket.instances[0];
    expect(mockWs.sentMessages).toContain(JSON.stringify({ type: 'subscribe', channel: 'ticker:BTCUSDT' }));

    // Simulate incoming event
    mockWs.simulateMessage({
      type: 'event',
      channel: 'ticker:BTCUSDT',
      data: { lastPrice: '50000' },
      timestamp: Date.now(),
    });

    expect(callback).toHaveBeenCalledWith({ lastPrice: '50000' }, 'event');

    unsub();
    expect(mockWs.sentMessages).toContain(JSON.stringify({ type: 'unsubscribe', channel: 'ticker:BTCUSDT' }));
    client.disconnect();
  });

  it('2. replays authentication and private channel subscriptions on connect', async () => {
    const client = new WebSocketClient('ws://localhost:4000/ws');
    client.setAuthToken('token-abc-123');

    const cb = vi.fn();
    client.subscribe('user:orders', cb);

    await new Promise(r => setTimeout(r, 20));

    const mockWs = MockWebSocket.instances[0];
    expect(mockWs.sentMessages).toContain(JSON.stringify({ type: 'auth', token: 'token-abc-123' }));

    // Simulate auth success
    mockWs.simulateMessage({
      type: 'auth_success',
      data: { userId: 'u1', email: 'user@test.com' },
    });

    // Should now subscribe to private channel
    expect(mockWs.sentMessages).toContain(JSON.stringify({ type: 'subscribe', channel: 'user:orders' }));

    client.disconnect();
  });

  it('3. deduplicates subscriptions for multiple listeners to the same channel', async () => {
    const client = new WebSocketClient('ws://localhost:4000/ws');
    const cb1 = vi.fn();
    const cb2 = vi.fn();

    const unsub1 = client.subscribe('ticker:ETHUSDT', cb1);
    const unsub2 = client.subscribe('ticker:ETHUSDT', cb2);

    await new Promise(r => setTimeout(r, 20));

    const mockWs = MockWebSocket.instances[0];
    // Subscribe frame sent only once
    const subFrames = mockWs.sentMessages.filter(m => m.includes('ticker:ETHUSDT'));
    expect(subFrames.length).toBe(1);

    mockWs.simulateMessage({
      type: 'event',
      channel: 'ticker:ETHUSDT',
      data: { lastPrice: '3000' },
      timestamp: Date.now(),
    });

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);

    unsub1(); // 1 listener still remains, so no unsubscribe frame yet
    expect(mockWs.sentMessages.filter(m => m.includes('unsubscribe')).length).toBe(0);

    unsub2(); // last listener removed, sends unsubscribe
    expect(mockWs.sentMessages).toContain(JSON.stringify({ type: 'unsubscribe', channel: 'ticker:ETHUSDT' }));

    client.disconnect();
  });
});
