import type { ControlCommand } from './control-contract';

export const dataPlaneBrand: unique symbol = Symbol('zterm.data-plane');

export type DataPlaneBrand = typeof dataPlaneBrand;

export interface DataEnvelope<T> {
  readonly [dataPlaneBrand]: true;
  readonly channelId: string;
  readonly revision: number;
  readonly body: T;
}

export function createDataEnvelope<T>(
  channelId: string,
  revision: number,
  body: T,
): DataEnvelope<T> {
  return { [dataPlaneBrand]: true, channelId, revision, body };
}

export type NodeResult<O, E> =
  | { readonly ok: true; readonly value: O }
  | { readonly ok: false; readonly error: E };

export function okNodeResult<O>(value: O): NodeResult<O, never> {
  return { ok: true, value };
}

export function errorNodeResult<E>(error: E): NodeResult<never, E> {
  return { ok: false, error };
}

export type NodeLifecycleState = 'created' | 'running' | 'stopping' | 'stopped';

export interface NodeIdentity {
  readonly nodeId: string;
  readonly moduleId: string;
  readonly featureId: string;
  readonly resources: readonly string[];
}

export interface Subscription {
  readonly disposed: boolean;
  dispose(reason: string): void;
}

export function createSubscription(onDispose: (reason: string) => void): Subscription {
  let disposed = false;
  return {
    get disposed() {
      return disposed;
    },
    dispose(reason: string) {
      if (disposed) return;
      disposed = true;
      onDispose(reason);
    },
  };
}

export class SubscriptionSet {
  private readonly handles = new Set<Subscription>();

  add(handle: Subscription): Subscription {
    this.handles.add(handle);
    return handle;
  }

  disposeAll(reason: string): void {
    for (const handle of [...this.handles]) {
      handle.dispose(reason);
    }
    this.handles.clear();
  }

  get size(): number {
    return this.handles.size;
  }
}

export interface DebugSnapshotRequest {
  readonly schemaVersion?: number;
  readonly nodeId?: string;
}

export interface DebugFilter {
  readonly nodeIds?: readonly string[];
  readonly sensitivity?: readonly string[];
  readonly kinds?: readonly string[];
}

export interface DebuggableNode<S, DE> {
  debugSnapshot(request: DebugSnapshotRequest): S;
  subscribeDebug(
    filter: DebugFilter,
    listener: (event: Readonly<DE>) => void,
  ): Subscription;
}

export abstract class FoundationNode<S, DE> implements DebuggableNode<S, DE> {
  abstract readonly identity: NodeIdentity;
  abstract start(): void | Promise<void>;
  abstract stop(reason: string): void | Promise<void>;
  abstract debugSnapshot(request: DebugSnapshotRequest): S;
  abstract subscribeDebug(
    filter: DebugFilter,
    listener: (event: Readonly<DE>) => void,
  ): Subscription;
}

export abstract class DataNode<I, O, E, S, DE> extends FoundationNode<S, DE> {
  abstract accept(
    input: Readonly<DataEnvelope<I>>,
  ): NodeResult<O, E> | Promise<NodeResult<O, E>>;
}

export abstract class ControlNode<C, R, E, EV, S, DE> extends FoundationNode<S, DE> {
  abstract execute(
    command: Readonly<ControlCommand<C>>,
  ): Promise<NodeResult<R, E>>;
  abstract subscribeEvents(
    listener: (event: Readonly<EV>) => void,
  ): Subscription;
}
