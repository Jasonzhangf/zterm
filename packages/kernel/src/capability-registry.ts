import { KernelContractError, requireNonEmpty } from './errors.ts';

export class CapabilityRegistry {
  private readonly providers = new Map<string, unknown>();

  register<T>(capabilityId: string, value: T): void {
    const id = requireNonEmpty(capabilityId, 'capabilityId');
    if (this.providers.has(id)) {
      throw new KernelContractError('duplicate_capability', `duplicate capability provider: ${id}`);
    }
    this.providers.set(id, value);
  }

  resolve<T>(capabilityId: string): T {
    const id = requireNonEmpty(capabilityId, 'capabilityId');
    if (!this.providers.has(id)) {
      throw new KernelContractError('capability_unavailable', `unavailable capability: ${id}`);
    }
    return this.providers.get(id) as T;
  }

  has(capabilityId: string): boolean {
    return this.providers.has(requireNonEmpty(capabilityId, 'capabilityId'));
  }

  require(capabilityIds: readonly string[]): void {
    const missing = capabilityIds
      .map((capabilityId) => requireNonEmpty(capabilityId, 'capabilityId'))
      .filter((capabilityId) => !this.providers.has(capabilityId));
    if (missing.length > 0) {
      throw new KernelContractError('capability_unavailable', `unavailable capabilities: ${missing.join(', ')}`);
    }
  }

  authorize(grantedCapabilityIds: readonly string[], requiredCapabilityId: string | undefined): boolean {
    if (requiredCapabilityId === undefined) return true;
    const required = requireNonEmpty(requiredCapabilityId, 'requiredCapabilityId');
    return grantedCapabilityIds.includes(required);
  }
}
