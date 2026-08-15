import type { CapabilityId, PluginCapabilityProvider } from './plugin-contract';

interface ProviderRecord {
  readonly value: unknown;
  readonly removable: boolean;
}

export class PluginCapabilityRegistry implements PluginCapabilityProvider {
  private readonly providers = new Map<CapabilityId, ProviderRecord>();

  registerProvider<T>(capabilityId: CapabilityId, value: T, removable: boolean): void {
    if (this.providers.has(capabilityId)) {
      throw new Error(`duplicate capability provider: ${capabilityId}`);
    }
    this.providers.set(capabilityId, { value, removable });
  }

  resolve<T>(capabilityId: CapabilityId): T {
    const record = this.providers.get(capabilityId);
    if (!record) {
      throw new Error(`unavailable capability: ${capabilityId}`);
    }
    return record.value as T;
  }

  has(capabilityId: CapabilityId): boolean {
    return this.providers.has(capabilityId);
  }

  removeProvider(capabilityId: CapabilityId): void {
    const record = this.providers.get(capabilityId);
    if (!record) {
      throw new Error(`unknown capability provider: ${capabilityId}`);
    }
    if (!record.removable) {
      throw new Error(`non-removable capability provider: ${capabilityId}`);
    }
    this.providers.delete(capabilityId);
  }
}
