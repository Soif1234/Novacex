import { 
  ILiquidityProviderAdapter, 
  ProviderCapability, 
  NormalizedOrderRequest, 
  NormalizedExecutionResponse,
  NormalizedTicker,
  NormalizedOrderBook,
  NormalizedTrade
} from './adapter';
import { ExecutionStatus } from '../../models/liquidity.model';
import { ProviderError, ProviderErrorCode } from './errors';
import { StateSafetyClassification, IStatefulComponent } from './classification';

export enum SimulationScenario {
  NORMAL = 'NORMAL',
  FULL_FILL = 'FULL_FILL',
  PARTIAL_FILL = 'PARTIAL_FILL',
  DELAYED_FILL = 'DELAYED_FILL',
  REJECT = 'REJECT',
  TIMEOUT_BEFORE_SUBMISSION = 'TIMEOUT_BEFORE_SUBMISSION',
  TIMEOUT_AFTER_SUBMISSION = 'TIMEOUT_AFTER_SUBMISSION',
  UNKNOWN = 'UNKNOWN',
  DUPLICATE_RESPONSE = 'DUPLICATE_RESPONSE',
  DUPLICATE_FILL = 'DUPLICATE_FILL',
  STALE_EVENT = 'STALE_EVENT',
  OUT_OF_ORDER = 'OUT_OF_ORDER',
  RATE_LIMITED = 'RATE_LIMITED',
  PROVIDER_DOWN = 'PROVIDER_DOWN',
  INVALID_RESPONSE = 'INVALID_RESPONSE',
  CANCELLED = 'CANCELLED',
  CANCEL_UNKNOWN = 'CANCEL_UNKNOWN',
  PROVIDER_RESTART = 'PROVIDER_RESTART'
}

export interface SimulationConfig {
  scenario: SimulationScenario;
  seed?: number;
  fillRatio?: number;
  executionPrice?: string;
  latencyMs?: number;
}

export class DeterministicRNG {
  private seed: number;
  constructor(seed: number) { this.seed = seed; }
  public next(): number {
    this.seed = (this.seed * 9301 + 49297) % 233280;
    return this.seed / 233280;
  }
}

export class SimulatedProvider implements ILiquidityProviderAdapter {
  private rng: DeterministicRNG;
  private orders: Map<string, NormalizedExecutionResponse> = new Map();
  private isDown: boolean = false;
  private internalSequence = 1;

  constructor(
    public readonly providerId: string,
    public config: SimulationConfig = { scenario: SimulationScenario.NORMAL }
  ) {
    this.rng = new DeterministicRNG(config.seed || 12345);
  }

  public setConfig(config: SimulationConfig) {
    this.config = config;
  }

  public setDown(down: boolean) {
    this.isDown = down;
  }

  public restart(clearState: boolean = false) {
    if (clearState) {
      this.orders.clear();
      this.internalSequence = 1;
    }
    this.isDown = false;
  }

  private checkAvailability() {
    if (this.isDown || this.config.scenario === SimulationScenario.PROVIDER_DOWN) {
      throw new ProviderError(ProviderErrorCode.PROVIDER_UNAVAILABLE, 'Provider is down', this.providerId);
    }
    if (this.config.scenario === SimulationScenario.RATE_LIMITED) {
      throw new ProviderError(ProviderErrorCode.RATE_LIMIT, 'Rate limit exceeded', this.providerId);
    }
  }

  public getCapabilities(): ProviderCapability[] {
    return [
      ProviderCapability.SPOT,
      ProviderCapability.FUTURES,
      ProviderCapability.MARKET_ORDER,
      ProviderCapability.ORDER_CANCEL,
      ProviderCapability.ORDER_STATUS,
      ProviderCapability.ORDER_BOOK
    ];
  }

  public hasCapability(cap: ProviderCapability): boolean {
    return this.getCapabilities().includes(cap);
  }

  public async healthCheck(): Promise<boolean> {
    return !this.isDown && this.config.scenario !== SimulationScenario.PROVIDER_DOWN;
  }

  public async getTicker(symbol: string): Promise<NormalizedTicker> {
    this.checkAvailability();
    const p = this.config.executionPrice || '50000';
    return { symbol, bid: p, ask: p, lastPrice: p, volume24h: '1000', timestamp: new Date() };
  }
  
  public async getOrderBook(symbol: string): Promise<NormalizedOrderBook> {
    this.checkAvailability();
    const p = this.config.executionPrice || '50000';
    return {
      symbol,
      bids: [{ price: p, quantity: '100' }],
      asks: [{ price: (Number(p) + 1).toString(), quantity: '100' }],
      timestamp: new Date()
    };
  }
  
  public async getTrades(symbol: string): Promise<NormalizedTrade[]> {
    this.checkAvailability();
    return [];
  }

  public async getBalances(): Promise<Record<string, string>> {
    this.checkAvailability();
    return { 'USDT': '1000000', 'BTC': '10' };
  }

  public async placeOrder(request: NormalizedOrderRequest): Promise<NormalizedExecutionResponse> {
    this.checkAvailability();

    if (this.config.scenario === SimulationScenario.TIMEOUT_BEFORE_SUBMISSION) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'Timeout before submission', this.providerId);
    }

    if (this.config.scenario === SimulationScenario.REJECT) {
      throw new ProviderError(ProviderErrorCode.ORDER_REJECTED, 'Order rejected by simulator', this.providerId);
    }

    const providerOrderId = `sim-order-${this.internalSequence++}`;
    let status: ExecutionStatus = 'ACKNOWLEDGED';
    const reqQtyNum = Number(request.quantity);
    let execQty = '0';
    let remQty = request.quantity;
    let avgPrice = '0';
    const priceToFill = this.config.executionPrice || request.price || '50000';
    
    // Simulate delay structurally (we can sleep if latencyMs is provided)
    if (this.config.latencyMs && this.config.latencyMs > 0) {
      await new Promise(r => setTimeout(r, this.config.latencyMs));
    }

    if (this.config.scenario === SimulationScenario.TIMEOUT_AFTER_SUBMISSION) {
      status = 'UNKNOWN';
      this.storeOrder(providerOrderId, request.clientOrderId, status, execQty, remQty, avgPrice);
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'Timeout after submission', this.providerId);
    }

    if (this.config.scenario === SimulationScenario.UNKNOWN) {
      status = 'UNKNOWN';
    } else if (this.config.scenario === SimulationScenario.FULL_FILL || this.config.scenario === SimulationScenario.NORMAL) {
      status = 'FILLED';
      execQty = request.quantity;
      remQty = '0';
      avgPrice = priceToFill;
    } else if (this.config.scenario === SimulationScenario.PARTIAL_FILL) {
      status = 'PARTIALLY_FILLED';
      const ratio = this.config.fillRatio || 0.4;
      execQty = (reqQtyNum * ratio).toString();
      remQty = (reqQtyNum - Number(execQty)).toString();
      avgPrice = priceToFill;
    } else if (this.config.scenario === SimulationScenario.INVALID_RESPONSE) {
      // Overfill + negative price to intentionally violate reconciliation constraints
      status = 'FILLED';
      execQty = (reqQtyNum + 10).toString(); // Overfill
      remQty = '0';
      avgPrice = '-5000'; // Invalid price
    } else if (this.config.scenario === SimulationScenario.CANCELLED) {
      status = 'CANCELLED';
    }

    const res = this.storeOrder(providerOrderId, request.clientOrderId, status, execQty, remQty, avgPrice);
    
    // Assign a sequence if we need to mock sequence-based reconciliation
    (res as any).sequence = this.internalSequence;
    
    return res;
  }

  public async cancelOrder(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse> {
    this.checkAvailability();
    
    if (this.config.scenario === SimulationScenario.TIMEOUT_BEFORE_SUBMISSION) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'Timeout before cancel', this.providerId);
    }

    const order = this.orders.get(providerOrderId);
    if (!order) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Unknown order', this.providerId);
    }

    if (this.config.scenario === SimulationScenario.CANCEL_UNKNOWN) {
      throw new ProviderError(ProviderErrorCode.TIMEOUT, 'Cancel status unknown', this.providerId);
    }

    if (order.status !== 'FILLED' && order.status !== 'CANCELLED') {
      order.status = 'CANCELLED';
      order.timestamps.updated = new Date();
      this.orders.set(providerOrderId, order);
    }

    return { ...order };
  }

  public async getOrderStatus(providerOrderId: string, symbol: string): Promise<NormalizedExecutionResponse> {
    this.checkAvailability();
    
    const order = this.orders.get(providerOrderId);
    if (!order) {
      // If we're testing missing order reconciliation
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, 'Unknown order', this.providerId);
    }

    let result = { ...order };
    (result as any).sequence = this.internalSequence++;

    if (this.config.scenario === SimulationScenario.STALE_EVENT) {
      // Intentionally return older snapshot logic
      result.status = 'ACKNOWLEDGED';
      result.executedQuantity = '0';
      result.remainingQuantity = (Number(result.executedQuantity) + Number(result.remainingQuantity)).toString();
      (result as any).sequence = 0; // Extremely stale sequence
    }
    
    if (this.config.scenario === SimulationScenario.OUT_OF_ORDER) {
       // Similar to stale event, simulating chaotic event stream
       (result as any).sequence = 9; 
       // When real order is at 10
    }

    if (this.config.scenario === SimulationScenario.DUPLICATE_FILL) {
       // Provide exact duplicate snapshot
       (result as any).sequence = 5; 
    }

    return result;
  }

  private storeOrder(
    providerOrderId: string, 
    clientOrderId: string, 
    status: ExecutionStatus, 
    execQty: string, 
    remQty: string, 
    avgPrice: string
  ): NormalizedExecutionResponse {
    const response: NormalizedExecutionResponse = {
      providerOrderId,
      clientOrderId,
      status,
      executedQuantity: execQty,
      remainingQuantity: remQty,
      averagePrice: avgPrice,
      fee: '0.001', // Example fee
      feeAsset: 'USDT',
      providerReference: providerOrderId,
      timestamps: {
        created: new Date(),
        updated: new Date()
      }
    };
    this.orders.set(providerOrderId, response);
    return { ...response };
  }
}
