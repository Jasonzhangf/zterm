import {
  createSubscription,
  type DebugFilter,
  type DebugSnapshotRequest,
  type NodeIdentity,
  type NodeLifecycleState,
  type Subscription,
} from './node-contract';

export type DebugSensitivity = 'public' | 'internal' | 'restricted';

export interface DebugSnapshotEnvelope<S> {
  readonly schemaVersion: number;
  readonly snapshotId: string;
  readonly nodeId: string;
  readonly moduleId: string;
  readonly featureId: string;
  readonly resources: readonly string[];
  readonly generation: number;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly lifecycle: NodeLifecycleState;
  readonly sensitivity: DebugSensitivity;
  readonly payload: Readonly<S>;
}

export interface DebugEvent<E> {
  readonly eventId: string;
  readonly nodeId: string;
  readonly kind: string;
  readonly sequence: number;
  readonly capturedAt: string;
  readonly sensitivity: DebugSensitivity;
  readonly payload: Readonly<E>;
}

export interface DebugProducer {
  readonly identity: NodeIdentity;
  debugSnapshot(request: DebugSnapshotRequest): unknown;
}

export function deepFreeze<T>(value: T): Readonly<T> {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value as Readonly<T>;
}

export class DebugRegistry {
  private readonly producers = new Map<string, DebugProducer>();

  register(producer: DebugProducer): void {
    const nodeId = producer.identity.nodeId;
    if (this.producers.has(nodeId)) {
      throw new Error(`duplicate debug producer: ${nodeId}`);
    }
    this.producers.set(nodeId, producer);
  }

  unregister(nodeId: string): void {
    this.producers.delete(nodeId);
  }

  has(nodeId: string): boolean {
    return this.producers.has(nodeId);
  }

  listNodeIds(): readonly string[] {
    return [...this.producers.keys()];
  }

  listProducers(): readonly DebugProducer[] {
    return [...this.producers.values()];
  }

  clear(): void {
    this.producers.clear();
  }
}

export class BoundedDebugEventStore<E> {
  private readonly entries: DebugEvent<E>[] = [];
  private readonly maxEvents: number;
  private dropCount = 0;

  constructor(maxEvents = 200) {
    this.maxEvents = Math.max(1, Math.floor(maxEvents));
  }

  push(event: DebugEvent<E>): boolean {
    if (this.entries.length >= this.maxEvents) {
      this.dropCount += 1;
      return false;
    }
    this.entries.push(deepFreeze(event));
    return true;
  }

  list(): readonly DebugEvent<E>[] {
    return this.entries;
  }

  getDropCount(): number {
    return this.dropCount;
  }
}

export function matchesDebugFilter(
  filter: DebugFilter,
  event: DebugEvent<unknown>,
): boolean {
  if (filter.nodeIds && !filter.nodeIds.includes(event.nodeId)) return false;
  if (filter.sensitivity && !filter.sensitivity.includes(event.sensitivity)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  return true;
}

export class SnapshotCoordinator {
  private readonly generations = new Map<string, number>();
  private readonly sequences = new Map<string, number>();

  constructor(private readonly registry: DebugRegistry) {}

  capture(
    producer: DebugProducer,
    lifecycle: NodeLifecycleState,
    request: DebugSnapshotRequest = {},
    sensitivity: DebugSensitivity = 'internal',
  ): DebugSnapshotEnvelope<unknown> {
    const identity = producer.identity;
    if (!this.registry.has(identity.nodeId)) {
      throw new Error(`snapshot producer not registered: ${identity.nodeId}`);
    }
    const generation = (this.generations.get(identity.nodeId) ?? 0) + 1;
    const sequence = (this.sequences.get(identity.nodeId) ?? 0) + 1;
    this.generations.set(identity.nodeId, generation);
    this.sequences.set(identity.nodeId, sequence);
    return deepFreeze({
      schemaVersion: request.schemaVersion ?? 1,
      snapshotId: `${identity.nodeId}:${generation}:${sequence}`,
      nodeId: identity.nodeId,
      moduleId: identity.moduleId,
      featureId: identity.featureId,
      resources: identity.resources,
      generation,
      sequence,
      capturedAt: new Date().toISOString(),
      lifecycle,
      sensitivity,
      payload: producer.debugSnapshot(request),
    }) as DebugSnapshotEnvelope<unknown>;
  }
}

export class DebugHub<DE> {
  private readonly subscribers: Array<{
    readonly filter: DebugFilter;
    readonly listener: (event: Readonly<DebugEvent<DE>>) => void;
  }> = [];
  private readonly store: BoundedDebugEventStore<DE>;
  private readonly maxSubscribers: number;
  private sequence = 0;
  private listenerErrorCount = 0;

  constructor(options: { readonly maxSubscribers?: number; readonly maxEvents?: number } = {}) {
    this.maxSubscribers = Math.max(1, Math.floor(options.maxSubscribers ?? 16));
    this.store = new BoundedDebugEventStore(options.maxEvents ?? 200);
  }

  subscribe(
    filter: DebugFilter,
    listener: (event: Readonly<DebugEvent<DE>>) => void,
  ): Subscription {
    if (this.subscribers.length >= this.maxSubscribers) {
      throw new Error(`debug subscriber limit reached: ${this.maxSubscribers}`);
    }
    const entry = { filter, listener };
    this.subscribers.push(entry);
    return createSubscription(() => {
      const index = this.subscribers.indexOf(entry);
      if (index >= 0) this.subscribers.splice(index, 1);
    });
  }

  publish(event: DebugEvent<DE>): boolean {
    if (!this.store.push(event)) return false;
    const frozen = deepFreeze(event);
    for (const subscriber of [...this.subscribers]) {
      if (!matchesDebugFilter(subscriber.filter, frozen)) continue;
      try {
        subscriber.listener(frozen);
      } catch {
        this.listenerErrorCount += 1;
      }
    }
    return true;
  }

  listEvents(): readonly DebugEvent<DE>[] {
    return this.store.list();
  }

  getDropCount(): number {
    return this.store.getDropCount();
  }

  getListenerErrorCount(): number {
    return this.listenerErrorCount;
  }

  nextEvent(
    nodeId: string,
    kind: string,
    sensitivity: DebugSensitivity,
    payload: Readonly<DE>,
  ): DebugEvent<DE> {
    this.sequence += 1;
    return {
      eventId: `${nodeId}:${kind}:${this.sequence}`,
      nodeId,
      kind,
      sequence: this.sequence,
      capturedAt: new Date().toISOString(),
      sensitivity,
      payload,
    };
  }
}

export type DebugPermissionCapability = 'debug:read' | 'debug:subscribe' | 'debug:control';

export interface DebugPermissionGrant {
  readonly capability: DebugPermissionCapability;
  readonly expiresAt: number;
}

export class DebugPermissionService {
  private readonly now: () => number;
  private grantValue: DebugPermissionGrant | null = null;

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  can(capability: DebugPermissionCapability): boolean {
    if (!this.grantValue || this.grantValue.capability !== capability) {
      return false;
    }
    return this.now() <= this.grantValue.expiresAt;
  }

  grant(capability: DebugPermissionCapability, leaseMs: number): DebugPermissionGrant {
    this.grantValue = {
      capability,
      expiresAt: this.now() + Math.max(1, Math.floor(Number.isFinite(leaseMs) ? leaseMs : 0)),
    };
    return this.grantValue;
  }

  revoke(): void {
    this.grantValue = null;
  }

  getGrant(): DebugPermissionGrant | null {
    if (this.grantValue && this.now() > this.grantValue.expiresAt) {
      this.revoke();
    }
    return this.grantValue;
  }

  getGrantSummary(): { readonly capability: DebugPermissionCapability | null; readonly expiresAt: number } {
    const grant = this.getGrant();
    return grant
      ? { capability: grant.capability, expiresAt: grant.expiresAt }
      : { capability: null, expiresAt: 0 };
  }
}
