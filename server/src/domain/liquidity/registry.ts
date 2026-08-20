import { ILiquidityProviderAdapter } from './adapter';
import { ProviderError, ProviderErrorCode } from './errors';

export class ProviderRegistry {
  private adapters: Map<string, ILiquidityProviderAdapter> = new Map();

  register(adapter: ILiquidityProviderAdapter): void {
    if (this.adapters.has(adapter.providerId)) {
      throw new ProviderError(
        ProviderErrorCode.INVALID_REQUEST,
        `Adapter ${adapter.providerId} is already registered`,
        adapter.providerId
      );
    }
    this.adapters.set(adapter.providerId, adapter);
  }

  getAdapter(providerId: string): ILiquidityProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      throw new ProviderError(
        ProviderErrorCode.PROVIDER_UNAVAILABLE,
        `Provider ${providerId} is not registered in the system`,
        providerId
      );
    }
    return adapter;
  }

  getAllProviders(): ILiquidityProviderAdapter[] {
    return Array.from(this.adapters.values());
  }

  clear(): void {
    this.adapters.clear();
  }
}

export const providerRegistry = new ProviderRegistry();
