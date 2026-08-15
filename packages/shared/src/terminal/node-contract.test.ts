import { describe, expect, it } from 'vitest';
import { createControlCommand } from './control-contract';
import {
  ControlNode,
  DataNode,
  createDataEnvelope,
  createSubscription,
  okNodeResult,
  SubscriptionSet,
  type NodeIdentity,
} from './node-contract';
import {
  DebugHub,
  DebugRegistry,
  SnapshotCoordinator,
  deepFreeze,
  type DebugEvent,
} from './debug-contract';

const testIdentity: NodeIdentity = {
  nodeId: 'shared-node-test',
  moduleId: 'shared.node_contract',
  featureId: 'shared.node_contract',
  resources: ['resource.runtime_node_registry'],
};

class DemoDataNode extends DataNode<
  number,
  number,
  { readonly code: string },
  { readonly revision: number },
  DebugEvent<{ readonly scope: string }>
> {
  readonly identity = testIdentity;
  private revision = 0;
  private readonly subscriptions = new SubscriptionSet();

  constructor(
    private readonly registry: DebugRegistry,
    private readonly hub: DebugHub<{ readonly scope: string }>,
  ) {
    super();
  }

  start(): void {
    this.registry.register({
      identity: this.identity,
      debugSnapshot: () => deepFreeze({ revision: this.revision }),
    });
  }

  stop(reason: string): void {
    this.subscriptions.disposeAll(reason);
    this.registry.unregister(this.identity.nodeId);
  }

  debugSnapshot() {
    return { revision: this.revision };
  }

  subscribeDebug(
    filter: Parameters<DebugHub<{ readonly scope: string }>['subscribe']>[0],
    listener: Parameters<DebugHub<{ readonly scope: string }>['subscribe']>[1],
  ) {
    return this.subscriptions.add(this.hub.subscribe(filter, listener));
  }

  async accept(input: Readonly<ReturnType<typeof createDataEnvelope<number>>>) {
    this.revision += input.body;
    return okNodeResult(this.revision);
  }
}

class StubControlNode extends ControlNode<
  { readonly cols: number },
  { readonly applied: true },
  string,
  { readonly resized: true },
  Record<string, never>,
  DebugEvent<Record<string, never>>
> {
  readonly identity = testIdentity;
  start(): void {}
  stop(): void {}
  debugSnapshot(): Record<string, never> {
    return {};
  }
  subscribeDebug() {
    return createSubscription(() => undefined);
  }
  subscribeEvents() {
    return createSubscription(() => undefined);
  }
  async execute() {
    return okNodeResult({ applied: true } as const);
  }
}

function makeDebugEvent(
  nodeId: string,
  kind: string,
  payload: { readonly scope: string },
): DebugEvent<{ readonly scope: string }> {
  return {
    eventId: `${nodeId}:${kind}:1`,
    nodeId,
    kind,
    sequence: 1,
    capturedAt: '2026-08-15T00:00:00.000Z',
    sensitivity: 'internal',
    payload,
  };
}

describe('shared foundation node contract', () => {
  it('starts and stops lifecycle deterministically and revokes subscriptions', () => {
    const registry = new DebugRegistry();
    const hub = new DebugHub<{ readonly scope: string }>();
    const node = new DemoDataNode(registry, hub);
    let calls = 0;
    const subscription = node.subscribeDebug({}, () => {
      calls += 1;
    });

    node.start();
    expect(registry.has(node.identity.nodeId)).toBe(true);
    hub.publish(makeDebugEvent(node.identity.nodeId, 'metric', { scope: 'revision' }));
    expect(calls).toBe(1);
    expect(subscription.disposed).toBe(false);

    node.stop('test');
    expect(subscription.disposed).toBe(true);
    expect(registry.has(node.identity.nodeId)).toBe(false);
    hub.publish(makeDebugEvent(node.identity.nodeId, 'metric', { scope: 'revision' }));
    expect(calls).toBe(1);
  });

  it('rejects duplicate debug producers', () => {
    const registry = new DebugRegistry();
    const producer = {
      identity: testIdentity,
      debugSnapshot: () => ({ revision: 0 }),
    };
    registry.register(producer);

    expect(() => registry.register(producer)).toThrow(/duplicate debug producer/);
  });

  it('produces versioned immutable snapshots', () => {
    const registry = new DebugRegistry();
    const producer = {
      identity: testIdentity,
      debugSnapshot: () => ({ revision: 1, nested: { value: 2 } }),
    };
    registry.register(producer);
    const coordinator = new SnapshotCoordinator(registry);

    const first = coordinator.capture(producer, 'running');
    const second = coordinator.capture(producer, 'running');

    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(first.snapshotId).not.toBe(second.snapshotId);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.payload)).toBe(true);
    expect(Object.isFrozen((first.payload as { nested: unknown }).nested)).toBe(true);
  });

  it('bounds debug subscriptions and releases capacity on dispose', () => {
    const hub = new DebugHub<{ readonly scope: string }>({ maxSubscribers: 1 });
    const first = hub.subscribe({}, () => undefined);

    expect(() => hub.subscribe({}, () => undefined)).toThrow(/subscriber limit/);
    first.dispose('test');
    expect(() => hub.subscribe({}, () => undefined)).not.toThrow();
  });

  it('keeps debug overflow and listener failures out of the data result', async () => {
    const registry = new DebugRegistry();
    const hub = new DebugHub<{ readonly scope: string }>({ maxEvents: 2 });
    const node = new DemoDataNode(registry, hub);
    node.subscribeDebug({}, () => {
      throw new Error('observer failure');
    });
    node.start();

    hub.publish(makeDebugEvent(node.identity.nodeId, 'metric', { scope: 'a' }));
    hub.publish(makeDebugEvent(node.identity.nodeId, 'metric', { scope: 'b' }));
    expect(hub.publish(makeDebugEvent(node.identity.nodeId, 'metric', { scope: 'c' }))).toBe(false);

    const result = await node.accept(createDataEnvelope('test', 1, 1));
    expect(result).toEqual({ ok: true, value: 1 });
    expect(hub.getDropCount()).toBe(1);
    expect(hub.getListenerErrorCount()).toBe(2);
  });

  it('keeps data and control envelopes non-interchangeable', async () => {
    const data = new DemoDataNode(new DebugRegistry(), new DebugHub());
    const control = new StubControlNode();

    // @ts-expect-error DataNode cannot accept a ControlCommand.
    void data.accept(createControlCommand('resize', 'c1', 'r1', { cols: 80 }));
    // @ts-expect-error ControlNode cannot execute a DataEnvelope.
    void control.execute(createDataEnvelope('rows', 1, []));

    expect(true).toBe(true);
  });
});
