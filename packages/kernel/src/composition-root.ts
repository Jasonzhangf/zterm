import { KernelContractError, requireNonEmpty } from './errors.ts';

export interface DisposableService {
  dispose(reason: string): void | Promise<void>;
}

export class CompositionRoot {
  private readonly services = new Map<string, unknown>();
  private disposed = false;

  bind<T>(serviceId: string, service: T): void {
    this.requireActive();
    const id = requireNonEmpty(serviceId, 'serviceId');
    if (this.services.has(id)) {
      throw new KernelContractError('duplicate_service', `duplicate runtime service: ${id}`);
    }
    this.services.set(id, service);
  }

  resolve<T>(serviceId: string): T {
    this.requireActive();
    const id = requireNonEmpty(serviceId, 'serviceId');
    if (!this.services.has(id)) {
      throw new KernelContractError('unbound_service', `unbound runtime service: ${id}`);
    }
    return this.services.get(id) as T;
  }

  require(serviceIds: readonly string[]): void {
    this.requireActive();
    const missing = serviceIds
      .map((serviceId) => requireNonEmpty(serviceId, 'serviceId'))
      .filter((serviceId) => !this.services.has(serviceId));
    if (missing.length > 0) {
      throw new KernelContractError('missing_service', `missing required runtime services: ${missing.join(', ')}`);
    }
  }

  has(serviceId: string): boolean {
    this.requireActive();
    return this.services.has(requireNonEmpty(serviceId, 'serviceId'));
  }

  async dispose(reason = 'kernel-dispose'): Promise<void> {
    if (this.disposed) {
      throw new KernelContractError('already_disposed', 'composition root is already disposed');
    }
    this.disposed = true;
    let firstError: unknown;
    const services = [...this.services.values()].reverse();
    for (const service of services) {
      if (!isDisposableService(service)) continue;
      try {
        await service.dispose(reason);
      } catch (error) {
        firstError ??= error;
      }
    }
    this.services.clear();
    if (firstError) throw firstError;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  private requireActive(): void {
    if (this.disposed) {
      throw new KernelContractError('already_disposed', 'composition root is already disposed');
    }
  }
}

function isDisposableService(value: unknown): value is DisposableService {
  return typeof value === 'object'
    && value !== null
    && typeof (value as DisposableService).dispose === 'function';
}
