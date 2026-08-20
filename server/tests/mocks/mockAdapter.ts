import {
  ILiquidityProviderAdapter,
  ProviderCapability,
  NormalizedTicker,
  NormalizedOrderBook,
  NormalizedTrade,
  NormalizedOrderRequest,
  NormalizedExecutionResponse
} from '../../src/domain/liquidity/adapter';
import { ProviderError, ProviderErrorCode } from '../../src/domain/liquidity/errors';

export class MockLiquidityAdapter implements ILiquidityProviderAdapter {
  constructor(public readonly providerId: string = 'MOCK_PROVIDER') {}

  getCapabilities(): ProviderCapability[] {
    return [
      ProviderCapability.SPOT,
      ProviderCapability.MARKET_ORDER,
      ProviderCapability.CLIENT_ORDER_ID
    ];
  }

  hasCapability(capability: ProviderCapability): boolean {
    return this.getCapabilities().includes(capability);
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  async getTicker(symbol: string): Promise<NormalizedTicker> {
    return {
      symbol,
      bid: '49900',
      ask: '50100',
      lastPrice: '50000',
      volume24h: '100',
      timestamp: new Date()
    };
  }

  async getOrderBook(symbol: string, depth?: number): Promise<NormalizedOrderBook> {
    if (!this.hasCapability(ProviderCapability.ORDER_BOOK)) {
      throw new ProviderError(ProviderErrorCode.UNSUPPORTED_OPERATION, 'Order book not supported', this.providerId);
    }
    return {
      symbol,
      bids: [],
      asks: [],
      timestamp: new Date()
    };
  }

  async getTrades(symbol: string): Promise<NormalizedTrade[]> {
    if (!this.hasCapability(ProviderCapability.TRADES)) {
      throw new ProviderError(ProviderErrorCode.UNSUPPORTED_OPERATION, 'Trades not supported', this.providerId);
    }
    return [];
  }

  async getBalances(): Promise<Record<string, string>> {
    return {
      'USDT': '10000',
      'BTC': '1.5'
    };
  }

  async placeOrder(request: NormalizedOrderRequest): Promise<NormalizedExecutionResponse> {
    if (!request.clientOrderId) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Missing clientOrderId', this.providerId);
    }

    // Simulate provider failure mapping
    if (request.metadata?.forceUnknownState) {
      throw new ProviderError(ProviderErrorCode.UNKNOWN_EXECUTION_STATE, 'Timeout during order placement', this.providerId);
    }

    return {
      providerOrderId: `mock-order-${Date.now()}`,
      clientOrderId: request.clientOrderId,
      status: 'FILLED',
      executedQuantity: request.quantity,
      remainingQuantity: '0',
      averagePrice: request.price || '50000',
      fee: '0.1',
      feeAsset: 'USDT',
      providerReference: 'mock-ref-123',
      timestamps: {
        created: new Date(),
        updated: new Date()
      }
    };
  }

  async cancelOrder(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse> {
    if (!this.hasCapability(ProviderCapability.ORDER_CANCEL)) {
      throw new ProviderError(ProviderErrorCode.UNSUPPORTED_OPERATION, 'Cancel not supported', this.providerId);
    }
    throw new ProviderError(ProviderErrorCode.UNSUPPORTED_OPERATION, 'Not implemented for mock', this.providerId);
  }

  async getOrderStatus(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse> {
    return {
      providerOrderId,
      clientOrderId: 'unknown-mock-cid',
      status: 'UNKNOWN',
      executedQuantity: '0',
      remainingQuantity: '0',
      averagePrice: '0',
      fee: '0',
      feeAsset: 'USDT',
      providerReference: '',
      timestamps: { created: new Date(), updated: new Date() }
    };
  }
}
