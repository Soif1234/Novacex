import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApiClient, ApiClientError } from './client';

describe('ApiClient (src/services/api/client.ts)', () => {
  let client: ApiClient;
  let fetchMock: any;

  beforeEach(() => {
    client = new ApiClient('http://localhost:4000/api/v1');
    fetchMock = vi.fn();
    global.fetch = fetchMock;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1. performs successful GET request and unwraps data', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { foo: 'bar' } }),
    });

    const res = await client.get<{ foo: string }>('/test');
    expect(res).toEqual({ foo: 'bar' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/test',
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        headers: expect.objectContaining({
          'Accept': 'application/json',
          'X-Request-ID': expect.any(String),
        }),
      })
    );
  });

  it('2. appends query parameters to GET request', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: [] }),
    });

    await client.get('/items', { symbol: 'BTCUSDT', limit: 10 });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/items?symbol=BTCUSDT&limit=10',
      expect.anything()
    );
  });

  it('3. performs POST request with JSON body', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ success: true, data: { id: '123' } }),
    });

    const res = await client.post<{ id: string }>('/orders', { symbol: 'BTCUSDT', quantity: '1' });
    expect(res).toEqual({ id: '123' });
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/orders',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ symbol: 'BTCUSDT', quantity: '1' }),
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      })
    );
  });

  it('4. throws normalized ApiClientError on HTTP error status', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({
        success: false,
        error: 'Invalid order quantity',
        code: 'INVALID_QUANTITY',
      }),
    });

    await expect(client.post('/orders', {})).rejects.toThrow(ApiClientError);

    try {
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () => JSON.stringify({
          success: false,
          error: 'Invalid order quantity',
          code: 'INVALID_QUANTITY',
        }),
      });
      await client.post('/orders', {});
    } catch (err: any) {
      expect(err).toBeInstanceOf(ApiClientError);
      expect(err.statusCode).toBe(400);
      expect(err.errorCode).toBe('INVALID_QUANTITY');
      expect(err.message).toBe('Invalid order quantity');
    }
  });

  it('5. triggers onUnauthorized listener on 401 response', async () => {
    const unauthSpy = vi.fn();
    client.onUnauthorized(unauthSpy);

    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({
        success: false,
        error: 'Session expired',
        code: 'UNAUTHORIZED',
      }),
    });

    await expect(client.get('/auth/me')).rejects.toThrow();
    expect(unauthSpy).toHaveBeenCalledTimes(1);
  });

  it('6. attaches session token header when token is set', async () => {
    client.setSessionToken('test-token-xyz');

    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, data: { ok: true } }),
    });

    await client.get('/protected');
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:4000/api/v1/protected',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Authorization': 'Bearer test-token-xyz',
          'X-Session-Token': 'test-token-xyz',
        }),
      })
    );
  });
});
