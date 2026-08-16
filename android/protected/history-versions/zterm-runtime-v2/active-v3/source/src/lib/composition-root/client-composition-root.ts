/**
 * Client composition root.
 *
 * Owns only declared runtime port binding and validation. It does not own
 * transport, session, buffer, renderer, plugin implementation, or business
 * truth; App supplies concrete values and consumers resolve them through the
 * declared port id.
 */

export interface RuntimePort<T> {
  readonly portId: string;
  readonly value: T;
}

export class ClientCompositionRoot {
  private readonly ports = new Map<string, unknown>();

  bind<T>(port: RuntimePort<T>): void {
    if (this.ports.has(port.portId)) {
      throw new Error(`duplicate runtime port: ${port.portId}`);
    }
    this.ports.set(port.portId, port.value);
  }

  resolve<T>(portId: string): T {
    if (!this.ports.has(portId)) {
      throw new Error(`unbound runtime port: ${portId}`);
    }
    return this.ports.get(portId) as T;
  }

  require(portIds: readonly string[]): void {
    const missing = portIds.filter((portId) => !this.ports.has(portId));
    if (missing.length > 0) {
      throw new Error(`missing required runtime ports: ${missing.join(', ')}`);
    }
  }

  has(portId: string): boolean {
    return this.ports.has(portId);
  }
}
