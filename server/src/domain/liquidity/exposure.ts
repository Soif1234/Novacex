import { ProviderError, ProviderErrorCode } from './errors';
import { ExecutionStatus } from '../../models/liquidity.model';
import { StateSafetyClassification, IStatefulComponent } from './classification';

export type ProviderHealthState = 'ACTIVE' | 'LIMITED' | 'DISABLED' | 'UNKNOWN';

export interface ExposureLimits {
  maxNotionalPerProvider: string;
  maxQuantityPerProvider: string;
  maxNotionalPerSymbol: string;
  maxPendingOrders: number;
  maxPendingNotional: string;
  maxSingleOrderNotional: string;
  maxSingleOrderQuantity: string;
}

export interface InventoryLimits {
  maxInventoryUsage: string;
  maxReservedInventory: string;
  maxPendingInventory: string;
  maxPerSymbolInventory: string;
}

export interface ProviderState {
  health: ProviderHealthState;
  
  // Exposure (Financial Notional Risk)
  currentExposure: number;
  pendingExposure: number;
  pendingOrderCount: number;

  // Inventory (Asset Quantities)
  availableInventory: number;
  reservedInventory: number;
  pendingInventory: number;
  
  symbolExposure: Map<string, number>;
  symbolInventory: Map<string, number>;
}

export interface ExposureDecision {
  allowed: boolean;
  reason?: string;
  requestedExposure?: string;
  currentExposure?: string;
  resultingExposure?: string;
  configuredLimit?: string;
}

export interface RouteRequest {
  providerId: string;
  symbol: string;
  notional: string;
  quantity: string;
}

// PERSISTENCE ABSTRACTION FOR EXPOSURE
export interface IExposureStore {
  saveReservation(orderId: string, req: RouteRequest): Promise<void>;
  deleteReservation(orderId: string): Promise<void>;
  getReservation(orderId: string): Promise<RouteRequest | undefined>;
  getAllReservations(): Promise<Map<string, RouteRequest>>;
}

export class InMemoryExposureStore implements IExposureStore, IStatefulComponent {
  private store: Map<string, RouteRequest> = new Map();

  async saveReservation(orderId: string, req: RouteRequest): Promise<void> {
    this.store.set(orderId, req);
  }

  async deleteReservation(orderId: string): Promise<void> {
    this.store.delete(orderId);
  }

  async getReservation(orderId: string): Promise<RouteRequest | undefined> {
    return this.store.get(orderId);
  }

  async getAllReservations(): Promise<Map<string, RouteRequest>> {
    return new Map(this.store);
  }

  getSafetyClassification(): StateSafetyClassification {
    return StateSafetyClassification.EPHEMERAL_SINGLE_NODE;
  }
}

export class ExposureGuard implements IStatefulComponent {
  private providerStates: Map<string, ProviderState> = new Map();
  private providerLimits: Map<string, ExposureLimits> = new Map();
  private inventoryLimits: Map<string, InventoryLimits> = new Map();

  constructor(private exposureStore: IExposureStore = new InMemoryExposureStore()) {}

  getSafetyClassification(): StateSafetyClassification {
    // The Guard requires a PERSISTENT_REQUIRED store underneath it in production.
    return StateSafetyClassification.PERSISTENT_REQUIRED;
  }

  public registerProvider(
    providerId: string, 
    exposureLimits: ExposureLimits, 
    inventoryLimits: InventoryLimits,
    initialHealth: ProviderHealthState = 'ACTIVE'
  ) {
    this.providerLimits.set(providerId, exposureLimits);
    this.inventoryLimits.set(providerId, inventoryLimits);
    this.providerStates.set(providerId, {
      health: initialHealth,
      currentExposure: 0,
      pendingExposure: 0,
      pendingOrderCount: 0,
      availableInventory: 0,
      reservedInventory: 0,
      pendingInventory: 0,
      symbolExposure: new Map(),
      symbolInventory: new Map()
    });
  }

  public setProviderHealth(providerId: string, health: ProviderHealthState) {
    const state = this.getProviderState(providerId);
    state.health = health;
  }

  public setAvailableInventory(providerId: string, symbol: string, quantity: string) {
    const qty = this.parseValidNumber(quantity, 'quantity');
    const state = this.getProviderState(providerId);
    state.availableInventory = qty;
  }

  public async syncFromStore(): Promise<void> {
    const reservations = await this.exposureStore.getAllReservations();
    // Reset pending states
    for (const state of this.providerStates.values()) {
      state.pendingExposure = 0;
      state.pendingOrderCount = 0;
      state.pendingInventory = 0;
      state.symbolExposure.clear();
      state.symbolInventory.clear();
    }
    
    // Reconstruct from persistent truth
    for (const req of reservations.values()) {
      const state = this.providerStates.get(req.providerId);
      if (!state) continue; // Provider might not be registered yet in this run
      
      const notional = this.parseValidNumber(req.notional, 'notional');
      const quantity = this.parseValidNumber(req.quantity, 'quantity');

      state.pendingExposure += notional;
      state.pendingOrderCount += 1;
      state.symbolExposure.set(req.symbol, (state.symbolExposure.get(req.symbol) || 0) + notional);
      
      state.pendingInventory += quantity;
      state.symbolInventory.set(req.symbol, (state.symbolInventory.get(req.symbol) || 0) + quantity);
    }
  }

  public canRoute(req: RouteRequest): ExposureDecision {
    return this.evaluateRoute(req);
  }

  public async reserveExposure(orderId: string, req: RouteRequest): Promise<ExposureDecision> {
    const decision = this.evaluateRoute(req);
    if (!decision.allowed) {
      return decision;
    }

    const existing = await this.exposureStore.getReservation(orderId);
    if (existing) {
       throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `Order ${orderId} already has reserved exposure`, 'EXPOSURE');
    }

    const state = this.getProviderState(req.providerId);
    const notional = this.parseValidNumber(req.notional, 'notional');
    const quantity = this.parseValidNumber(req.quantity, 'quantity');

    state.pendingExposure += notional;
    state.pendingOrderCount += 1;
    state.symbolExposure.set(req.symbol, (state.symbolExposure.get(req.symbol) || 0) + notional);

    state.pendingInventory += quantity;
    state.symbolInventory.set(req.symbol, (state.symbolInventory.get(req.symbol) || 0) + quantity);

    await this.exposureStore.saveReservation(orderId, req);
    
    return decision;
  }

  public async releaseExposure(orderId: string): Promise<void> {
    const req = await this.exposureStore.getReservation(orderId);
    if (!req) return; // already released or never reserved

    const state = this.getProviderState(req.providerId);
    const notional = this.parseValidNumber(req.notional, 'notional');
    const quantity = this.parseValidNumber(req.quantity, 'quantity');

    state.pendingExposure -= notional;
    state.pendingOrderCount -= 1;
    state.symbolExposure.set(req.symbol, Math.max(0, (state.symbolExposure.get(req.symbol) || 0) - notional));

    state.pendingInventory -= quantity;
    state.symbolInventory.set(req.symbol, Math.max(0, (state.symbolInventory.get(req.symbol) || 0) - quantity));

    await this.exposureStore.deleteReservation(orderId);
  }

  public async applyExecution(orderId: string, executedNotional: string, executedQuantity: string, status: ExecutionStatus): Promise<void> {
    const req = await this.exposureStore.getReservation(orderId);
    if (!req) return; // Unknown order reservation

    const state = this.getProviderState(req.providerId);
    const eNotional = this.parseValidNumber(executedNotional, 'executedNotional');
    const eQuantity = this.parseValidNumber(executedQuantity, 'executedQuantity');
    const plannedNotional = this.parseValidNumber(req.notional, 'notional');
    const plannedQuantity = this.parseValidNumber(req.quantity, 'quantity');

    switch (status) {
      case 'FILLED':
        // Convert pending to current
        await this.releaseExposure(orderId); // releases full pending
        state.currentExposure += eNotional;
        state.availableInventory = Math.max(0, state.availableInventory - eQuantity);
        break;

      case 'PARTIALLY_FILLED':
        // A terminal partial fill means the rest is canceled.
        await this.releaseExposure(orderId);
        state.currentExposure += eNotional;
        state.availableInventory = Math.max(0, state.availableInventory - eQuantity);
        break;

      case 'CANCELLED':
      case 'REJECTED':
      case 'FAILED':
        await this.releaseExposure(orderId);
        break;

      case 'UNKNOWN':
      case 'RECONCILING':
      case 'SUBMITTED':
      case 'ROUTING':
      case 'ACKNOWLEDGED':
      case 'CANCEL_PENDING':
      case 'VALIDATED':
      case 'CREATED':
      case 'RESERVED':
        // Pending state continues. Do not release.
        break;
      
      case 'CONFIRMED':
        // Usually synonymous with FILLED or terminal verified execution
        await this.releaseExposure(orderId);
        state.currentExposure += eNotional;
        state.availableInventory = Math.max(0, state.availableInventory - eQuantity);
        break;
    }
  }

  public getExposure(providerId: string) {
    return this.getProviderState(providerId);
  }

  private evaluateRoute(req: RouteRequest): ExposureDecision {
    const state = this.getProviderState(req.providerId);
    const expLimits = this.providerLimits.get(req.providerId)!;
    const invLimits = this.inventoryLimits.get(req.providerId)!;

    const notional = this.parseValidNumber(req.notional, 'notional');
    const quantity = this.parseValidNumber(req.quantity, 'quantity');

    if (state.health === 'DISABLED') return this.reject('PROVIDER_DISABLED');
    if (state.health === 'UNKNOWN') return this.reject('UNKNOWN_EXPOSURE');
    // If LIMITED, we could apply a fractional multiplier, but for now we enforce limits strictly.

    if (notional > Number(expLimits.maxSingleOrderNotional)) return this.reject('ORDER_EXPOSURE_LIMIT_EXCEEDED');
    if (quantity > Number(expLimits.maxSingleOrderQuantity)) return this.reject('QUANTITY_LIMIT_EXCEEDED');

    const totalProposedExposure = state.currentExposure + state.pendingExposure + notional;
    if (totalProposedExposure > Number(expLimits.maxNotionalPerProvider)) return this.reject('EXPOSURE_LIMIT_EXCEEDED', String(notional), String(state.currentExposure + state.pendingExposure), String(totalProposedExposure), expLimits.maxNotionalPerProvider);

    if (state.pendingExposure + notional > Number(expLimits.maxPendingNotional)) return this.reject('PENDING_EXPOSURE_LIMIT_EXCEEDED');
    if (state.pendingOrderCount + 1 > expLimits.maxPendingOrders) return this.reject('PENDING_EXPOSURE_LIMIT_EXCEEDED');

    const symbolExp = (state.symbolExposure.get(req.symbol) || 0) + notional;
    if (symbolExp > Number(expLimits.maxNotionalPerSymbol)) return this.reject('SYMBOL_EXPOSURE_LIMIT_EXCEEDED');

    // Inventory checks
    const available = state.availableInventory - state.reservedInventory - state.pendingInventory;
    if (quantity > available) return this.reject('INVENTORY_LIMIT_EXCEEDED');
    
    if (state.pendingInventory + quantity > Number(invLimits.maxPendingInventory)) return this.reject('INVENTORY_LIMIT_EXCEEDED');

    return { allowed: true };
  }

  private getProviderState(providerId: string): ProviderState {
    const state = this.providerStates.get(providerId);
    if (!state) {
      throw new ProviderError(ProviderErrorCode.PROVIDER_UNAVAILABLE, `Provider ${providerId} not found`, 'EXPOSURE');
    }
    return state;
  }

  private parseValidNumber(val: string, label: string): number {
    const n = Number(val);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      throw new ProviderError(ProviderErrorCode.INVALID_REQUEST, `INVALID_${label.toUpperCase()}`, 'EXPOSURE');
    }
    return n;
  }

  private reject(reason: string, requested?: string, current?: string, resulting?: string, limit?: string): ExposureDecision {
    return { allowed: false, reason, requestedExposure: requested, currentExposure: current, resultingExposure: resulting, configuredLimit: limit };
  }
}
