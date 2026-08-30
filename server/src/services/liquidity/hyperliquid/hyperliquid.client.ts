/**
 * Hyperliquid Typed HTTP REST Client
 * Phase 10.5 â€” Step 10.5-2
 */

import * as crypto from 'crypto';
import {
  HyperliquidClientConfig,
  HyperliquidL1Action,
  HyperliquidExchangePayload,
  HyperliquidExchangeResponse,
  HyperliquidMetaResponse,
  HyperliquidSpotMetaResponse,
  HyperliquidL2BookResponse,
  HyperliquidClearinghouseState,
  HyperliquidSpotClearinghouseState,
  HyperliquidOpenOrder,
  HyperliquidUserFill,
  HyperliquidOrderStatusResponse,
  HyperliquidError,
  HyperliquidErrorCode
} from './hyperliquid.types';
import { HyperliquidSigner } from './hyperliquid.signer';

import Redis from 'ioredis';

export class HyperliquidNonceManager {
  private lastNonce: number = 0;
  private readonly redis?: Redis;
  private readonly redisKey: string;

  constructor(redis?: Redis, agentWalletAddress: string = 'default') {
    this.redis = redis;
    this.redisKey = `hyperliquid:nonce:${agentWalletAddress.toLowerCase()}`;
  }

  /**
   * Generates a strictly monotonically increasing millisecond timestamp nonce.
   * Isolated completely from on-chain transaction nonces.
   * If Redis is provided, uses atomic Lua script to coordinate across instances.
   */
  public async getNextNonce(): Promise<number> {
    const now = Date.now();

    if (this.redis) {
      // Lua script ensures atomic increment guaranteeing monotonicity across distributed workers
      const script = `
        local current = tonumber(redis.call('get', KEYS[1]) or '0')
        local now = tonumber(ARGV[1])
        if now > current then
          redis.call('set', KEYS[1], now)
          return now
        else
          local next_val = current + 1
          redis.call('set', KEYS[1], next_val)
          return next_val
        end
      `;
      const result = await this.redis.eval(script, 1, this.redisKey, now.toString());
      return Number(result);
    } else {
      // Fallback for single-process / tests
      if (now > this.lastNonce) {
        this.lastNonce = now;
      } else {
        this.lastNonce += 1;
      }
      return this.lastNonce;
    }
  }
}

export class HyperliquidRateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private lastRefill: number;

  constructor(maxTokensPerMin: number = 1200) {
    this.maxTokens = maxTokensPerMin;
    this.tokens = maxTokensPerMin;
    this.refillRatePerMs = maxTokensPerMin / 60000;
    this.lastRefill = Date.now();
  }

  public async acquire(weight: number = 1): Promise<void> {
    this.refill();
    if (this.tokens >= weight) {
      this.tokens -= weight;
      return;
    }

    const deficit = weight - this.tokens;
    const waitTimeMs = Math.ceil(deficit / this.refillRatePerMs);
    await new Promise(resolve => setTimeout(resolve, Math.min(waitTimeMs, 2000)));
    this.refill();
    this.tokens = Math.max(0, this.tokens - weight);
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }
}

export class HyperliquidClient {
  private readonly baseUrl: string;
  private readonly isMainnet: boolean;
  private readonly signer?: HyperliquidSigner;
  private readonly accountAddress?: string;
  private readonly vaultAddress: string | null;
  private readonly timeoutMs: number;
  private readonly nonceManager: HyperliquidNonceManager;
  private readonly infoRateLimiter: HyperliquidRateLimiter;
  private readonly exchangeRateLimiter: HyperliquidRateLimiter;

  constructor(config: HyperliquidClientConfig) {
    this.isMainnet = config.hyperliquidEnv === 'mainnet';
    this.baseUrl = this.isMainnet ? 'https://api.hyperliquid.xyz' : 'https://api.hyperliquid-testnet.xyz';

    this.vaultAddress = config.vaultAddress || null;
    this.timeoutMs = config.requestTimeoutMs || 5000;
    this.nonceManager = new HyperliquidNonceManager(config.redis, config.accountAddress || 'default');
    this.infoRateLimiter = new HyperliquidRateLimiter(1200); // 1200 weight/min
    this.exchangeRateLimiter = new HyperliquidRateLimiter(100); // 100 weight/min per account

    if (config.agentPrivateKey) {
      this.signer = new HyperliquidSigner(config.agentPrivateKey, this.isMainnet);
    }

    if (config.accountAddress) {
      this.accountAddress = config.accountAddress.toLowerCase();
    } else if (this.signer) {
      this.accountAddress = this.signer.address;
    }
  }

  public getAgentAddress(): string | undefined {
    return this.signer?.address;
  }

  public getAccountAddress(): string | undefined {
    return this.accountAddress;
  }

  // ==========================================
  // 1. INFO API CALLS (/info)
  // ==========================================

  public async getMeta(): Promise<HyperliquidMetaResponse> {
    return this.postInfo<HyperliquidMetaResponse>({ type: 'meta' });
  }

  public async getSpotMeta(): Promise<HyperliquidSpotMetaResponse> {
    return this.postInfo<HyperliquidSpotMetaResponse>({ type: 'spotMeta' });
  }

  public async getAllMids(): Promise<Record<string, string>> {
    return this.postInfo<Record<string, string>>({ type: 'allMids' });
  }

  public async getL2Book(coin: string): Promise<HyperliquidL2BookResponse> {
    return this.postInfo<HyperliquidL2BookResponse>({ type: 'l2Book', coin });
  }

  public async getClearinghouseState(userAddress?: string): Promise<HyperliquidClearinghouseState> {
    const user = userAddress || this.accountAddress;
    if (!user) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'user address is required to query clearinghouseState'
      );
    }
    return this.postInfo<HyperliquidClearinghouseState>({ type: 'clearinghouseState', user });
  }

  public async getSpotClearinghouseState(userAddress?: string): Promise<HyperliquidSpotClearinghouseState> {
    const user = userAddress || this.accountAddress;
    if (!user) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'user address is required to query spotClearinghouseState'
      );
    }
    return this.postInfo<HyperliquidSpotClearinghouseState>({ type: 'spotClearinghouseState', user });
  }

  public async getOpenOrders(userAddress?: string): Promise<HyperliquidOpenOrder[]> {
    const user = userAddress || this.accountAddress;
    if (!user) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'user address is required to query openOrders'
      );
    }
    return this.postInfo<HyperliquidOpenOrder[]>({ type: 'openOrders', user });
  }

  public async getUserFills(userAddress?: string): Promise<HyperliquidUserFill[]> {
    const user = userAddress || this.accountAddress;
    if (!user) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'user address is required to query userFills'
      );
    }
    return this.postInfo<HyperliquidUserFill[]>({ type: 'userFills', user });
  }

  public async getOrderStatus(oid: number, userAddress?: string): Promise<HyperliquidOrderStatusResponse> {
    const user = userAddress || this.accountAddress;
    if (!user) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'user address is required to query orderStatus'
      );
    }
    return this.postInfo<HyperliquidOrderStatusResponse>({ type: 'orderStatus', user, oid });
  }

  // ==========================================
  // 2. EXCHANGE API CALLS (/exchange)
  // ==========================================

  public async postExchangeAction(
    action: HyperliquidL1Action,
    expiresAfter: number | null = null
  ): Promise<HyperliquidExchangeResponse> {
    if (!this.signer) {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_CREDENTIALS,
        'Cannot execute exchange action without Agent Private Key'
      );
    }

    await this.exchangeRateLimiter.acquire(1);

    const nonce = await this.nonceManager.getNextNonce();
    const { signature } = await this.signer.signL1Action(action, nonce, this.vaultAddress, expiresAfter);

    const payload: HyperliquidExchangePayload = {
      action,
      nonce,
      signature,
      vaultAddress: this.vaultAddress
    };

    const url = `${this.baseUrl}/exchange`;
    const response = await this.fetchWithTimeout(url, payload);
    return this.parseExchangeResponse(response);
  }

  // ==========================================
  // 3. UTILITY METHODS
  // ==========================================

  /**
   * Generates a deterministic 16-byte hex string (32 hex characters with 0x prefix)
   * from a NovaCEX hedgeIntentId for idempotent venue tracking.
   */
  public generateCloid(hedgeIntentId: string): string {
    if (!hedgeIntentId || hedgeIntentId.trim() === '') {
      throw new HyperliquidError(
        HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
        'hedgeIntentId cannot be empty'
      );
    }
    const hash = crypto.createHash('sha256').update(hedgeIntentId).digest('hex');
    return `0x${hash.substring(0, 32)}`;
  }

  private async postInfo<T>(payload: any): Promise<T> {
    await this.infoRateLimiter.acquire(1);
    const url = `${this.baseUrl}/info`;
    return this.fetchWithTimeout(url, payload);
  }

  private async fetchWithTimeout(url: string, body: any): Promise<any> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });

      if (!res.ok) {
        const text = await res.text();
        if (res.status === 429) {
          throw new HyperliquidError(
            HyperliquidErrorCode.RATE_LIMIT_EXCEEDED,
            'Hyperliquid rate limit exceeded (HTTP 429)',
            { status: res.status, body: text },
            true
          );
        }
        if (res.status === 401 || res.status === 403) {
          throw new HyperliquidError(
            HyperliquidErrorCode.INVALID_CREDENTIALS,
            `Hyperliquid unauthorized (HTTP ${res.status}): ${text}`,
            { status: res.status, body: text },
            false
          );
        }
        throw new HyperliquidError(
          HyperliquidErrorCode.INVALID_ORDER_PARAMETERS,
          `HTTP Error ${res.status}: ${text}`,
          { status: res.status, body: text },
          res.status >= 500
        );
      }

      const json = await res.json();
      return json;
    } catch (err: any) {
      if (err.name === 'AbortError' || err.message?.includes('timeout') || err.message?.includes('aborted')) {
        throw new HyperliquidError(
          HyperliquidErrorCode.NETWORK_TIMEOUT,
          `Request timeout after ${this.timeoutMs}ms`,
          { url },
          true
        );
      }
      if (err instanceof HyperliquidError) {
        throw err;
      }
      throw new HyperliquidError(
        HyperliquidErrorCode.NETWORK_TIMEOUT,
        `Transport error: ${err.message}`,
        { error: err.message },
        true
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private parseExchangeResponse(response: any): HyperliquidExchangeResponse {
    if (!response || typeof response !== 'object') {
      throw new HyperliquidError(
        HyperliquidErrorCode.UNKNOWN_ORDER,
        'Malformed exchange response payload'
      );
    }

    if (response.status === 'err') {
      const errMsg = typeof response.response === 'string' ? response.response : JSON.stringify(response.response);

      let code = HyperliquidErrorCode.INVALID_ORDER_PARAMETERS;
      let isRetryable = false;

      if (errMsg.toLowerCase().includes('insufficient margin')) {
        code = HyperliquidErrorCode.INSUFFICIENT_MARGIN;
      } else if (errMsg.toLowerCase().includes('reduce only')) {
        code = HyperliquidErrorCode.REDUCE_ONLY_VIOLATION;
      } else if (errMsg.toLowerCase().includes('rate limit')) {
        code = HyperliquidErrorCode.RATE_LIMIT_EXCEEDED;
        isRetryable = true;
      }

      throw new HyperliquidError(code, `Exchange rejected action: ${errMsg}`, response, isRetryable);
    }

    return response as HyperliquidExchangeResponse;
  }
}
