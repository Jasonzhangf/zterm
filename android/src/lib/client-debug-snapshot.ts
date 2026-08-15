import {
  DebugRegistry,
  SnapshotCoordinator,
  deepFreeze,
  type DebugProducer,
  type DebugSensitivity,
} from '@zterm/shared/terminal/debug-contract';
import type { NodeIdentity, NodeLifecycleState } from '@zterm/shared/terminal/node-contract';

export type ClientDebugSnapshotProducer = () => unknown;

const clientDebugIdentity: NodeIdentity = {
  nodeId: 'client.runtime.debug',
  moduleId: 'observability.debug_channel',
  featureId: 'client.debug_console',
  resources: [
    'resource.runtime_node_registry',
    'resource.debug_snapshot_registry',
    'resource.observability_channel',
  ],
};

const snapshotRegistry = new DebugRegistry();
let snapshotCoordinator = new SnapshotCoordinator(snapshotRegistry);
const clientDebugProducer: DebugProducer = {
  identity: clientDebugIdentity,
  debugSnapshot: () => collectClientDebugSnapshotPayload(),
};

snapshotRegistry.register(clientDebugProducer);

export function resetClientDebugSnapshotForTests() {
  snapshotRegistry.clear();
  snapshotRegistry.register(clientDebugProducer);
  snapshotCoordinator = new SnapshotCoordinator(snapshotRegistry);
}

function readVisualViewport() {
  if (typeof window === 'undefined' || !window.visualViewport) {
    return null;
  }
  return {
    width: Number(window.visualViewport.width || 0),
    height: Number(window.visualViewport.height || 0),
    offsetTop: Number(window.visualViewport.offsetTop || 0),
    offsetLeft: Number(window.visualViewport.offsetLeft || 0),
    scale: Number(window.visualViewport.scale || 1),
  };
}

function readWindowMetrics() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return null;
  }
  return {
    innerWidth: Number(window.innerWidth || 0),
    innerHeight: Number(window.innerHeight || 0),
    outerWidth: Number(window.outerWidth || 0),
    outerHeight: Number(window.outerHeight || 0),
    documentClientWidth: Number(document.documentElement?.clientWidth || 0),
    documentClientHeight: Number(document.documentElement?.clientHeight || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
    visualViewport: readVisualViewport(),
  };
}

export function registerClientDebugSnapshotSource(sourceId: string, producer: ClientDebugSnapshotProducer) {
  snapshotRegistry.register({
    identity: {
      ...clientDebugIdentity,
      nodeId: sourceId,
    },
    debugSnapshot: () => producer(),
  });
  return () => {
    snapshotRegistry.unregister(sourceId);
  };
}

function collectClientDebugSnapshotPayload() {
  const sources: Record<string, unknown> = {};
  for (const producer of snapshotRegistry.listProducers()) {
    const sourceId = producer.identity.nodeId;
    if (sourceId === clientDebugIdentity.nodeId) continue;
    try {
      sources[sourceId] = producer.debugSnapshot({});
    } catch (error) {
      sources[sourceId] = {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return {
    sources,
    generatedAt: new Date().toISOString(),
    documentHidden: typeof document === 'undefined' ? null : Boolean(document.hidden),
    online: typeof navigator === 'undefined' ? null : Boolean(navigator.onLine),
    userAgent: typeof navigator === 'undefined' ? '' : navigator.userAgent,
    window: readWindowMetrics(),
  };
}

export function collectClientDebugSnapshot(
  extra?: Record<string, unknown>,
  lifecycle: NodeLifecycleState = 'running',
  sensitivity: DebugSensitivity = 'internal',
) {
  const envelope = snapshotCoordinator.capture(
    clientDebugProducer,
    lifecycle,
    {},
    sensitivity,
  );
  const payload = envelope.payload as ReturnType<typeof collectClientDebugSnapshotPayload> & {
    extra?: Record<string, unknown> | null;
  };
  return deepFreeze({
    ...envelope,
    generatedAt: payload.generatedAt,
    documentHidden: payload.documentHidden,
    online: payload.online,
    userAgent: payload.userAgent,
    window: payload.window,
    sources: payload.sources,
    extra: extra ? { ...extra } : null,
  });
}
