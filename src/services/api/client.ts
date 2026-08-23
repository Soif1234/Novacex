/**
 * Unified HTTP API Client
 *
 * Communicates with authoritative backend REST API (/api/v1).
 * Features:
 *  - Configurable baseURL
 *  - Automatic credentials inclusion (HttpOnly session cookies)
 *  - Authorization header fallback for token-based environments
 *  - X-Request-ID propagation
 *  - Normalized ApiClientError with typed error codes
 *  - Timeout & abort controller support
 *  - Global 401 unauthorized session listener
 */

import { ApiResponse } from './types';

export class ApiClientError extends Error {
  public readonly statusCode: number;
  public readonly errorCode: string;
  public readonly details?: unknown;

  constructor(message: string, statusCode: number, errorCode = 'UNKNOWN_ERROR', details?: unknown) {
    super(message);
    this.name = 'ApiClientError';
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

export interface RequestOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
  skipAuth?: boolean;
}

export class ApiClient {
  private baseURL: string;
  private sessionToken: string | null = null;
  private onUnauthorizedCallback: (() => void) | null = null;

  constructor(baseURL?: string) {
    // In browser/Vite: VITE_API_BASE_URL or fallback to http://localhost:4000/api/v1
    const envBase = typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_API_BASE_URL;
    this.baseURL = (baseURL || envBase || 'http://localhost:4000/api/v1').replace(/\/+$/, '');
  }

  public setBaseURL(url: string): void {
    this.baseURL = url.replace(/\/+$/, '');
  }

  public getBaseURL(): string {
    return this.baseURL;
  }

  public setSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  public getSessionToken(): string | null {
    return this.sessionToken;
  }

  public onUnauthorized(callback: () => void): void {
    this.onUnauthorizedCallback = callback;
  }

  private generateRequestId(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `req-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private generateIdempotencyKey(): string {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `idemp-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH',
    endpoint: string,
    body?: unknown,
    options: RequestOptions = {}
  ): Promise<T> {
    const cleanEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    const url = `${this.baseURL}${cleanEndpoint}`;

    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'X-Request-ID': this.generateRequestId(),
      ...options.headers,
    };

    // Automatically inject Idempotency-Key on mutating requests to protect against network retry duplicate execution
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !headers['Idempotency-Key']) {
      headers['Idempotency-Key'] = this.generateIdempotencyKey();
    }

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    if (!options.skipAuth && this.sessionToken) {
      headers['Authorization'] = `Bearer ${this.sessionToken}`;
      headers['X-Session-Token'] = this.sessionToken;
    }

    const controller = new AbortController();
    const timeoutMs = options.timeoutMs || 15000;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        credentials: 'include', // Ensures HttpOnly cookies (mallick_session) are sent automatically
        signal: options.signal || controller.signal,
      });

      clearTimeout(timeoutId);

      let json: ApiResponse<T> | null = null;
      const text = await response.text();
      if (text) {
        try {
          json = JSON.parse(text);
        } catch {
          // Non-JSON response
        }
      }

      if (!response.ok) {
        const statusCode = response.status;
        const retryAfter = (response.headers && typeof response.headers.get === 'function') ? response.headers.get('Retry-After') : null;
        const errorCode = (json as any)?.code || (json as any)?.error?.code || (typeof (json as any)?.error === 'string' ? (json as any).error : null) || `HTTP_${statusCode}`;
        const errorMessage = (json as any)?.message || (json as any)?.error?.message || (typeof (json as any)?.error === 'string' ? (json as any).error : null) || response.statusText || `Request failed with status ${statusCode}`;
        const details = (json as any)?.error?.details || (json as any)?.details || (retryAfter ? { retryAfterSeconds: Number(retryAfter) } : undefined);

        if (statusCode === 401 && this.onUnauthorizedCallback) {
          this.onUnauthorizedCallback();
        }

        throw new ApiClientError(errorMessage, statusCode, errorCode, details);
      }


      // If backend wrapped in { success: true, data: ... }
      if (json && typeof json === 'object' && 'success' in json && 'data' in json) {
        return json.data as T;
      }

      return (json as unknown as T) ?? ({} as T);
    } catch (err: any) {
      clearTimeout(timeoutId);

      if (err instanceof ApiClientError) {
        throw err;
      }

      if (err.name === 'AbortError') {
        throw new ApiClientError('Request timed out', 408, 'REQUEST_TIMEOUT');
      }

      throw new ApiClientError(err.message || 'Network error communicating with server', 0, 'NETWORK_ERROR');
    }
  }

  public async get<T>(endpoint: string, query?: Record<string, string | number | boolean | undefined>, options?: RequestOptions): Promise<T> {
    let url = endpoint;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined && v !== null && v !== '') {
          params.append(k, String(v));
        }
      }
      const qs = params.toString();
      if (qs) {
        url = `${url}${url.includes('?') ? '&' : '?'}${qs}`;
      }
    }
    return this.request<T>('GET', url, undefined, options);
  }

  public async post<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('POST', endpoint, body, options);
  }

  public async put<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PUT', endpoint, body, options);
  }

  public async patch<T>(endpoint: string, body?: unknown, options?: RequestOptions): Promise<T> {
    return this.request<T>('PATCH', endpoint, body, options);
  }

  public async delete<T>(endpoint: string, options?: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', endpoint, undefined, options);
  }
}

export const apiClient = new ApiClient();

