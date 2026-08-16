import type {
  DebugObservabilityClientRequest,
  DebugObservabilityLogRequest,
  DebugObservabilitySnapshotRequest,
} from '@zterm/shared/protocol';
import { collectClientDebugSnapshot } from './client-debug-snapshot';
import {
  drainRuntimeDebugEntries,
  getPendingRuntimeDebugEntryCount,
  isRuntimeDebugEnabled,
} from './runtime-debug';

export interface DebugObservabilityTarget {
  targetHost: string;
  targetPort: number;
  targetAuthToken?: string;
}

export interface DebugObservabilityHttpResult {
  ok: boolean;
  status: number;
  text: string;
}

export interface DebugObservabilityHttpTransport {
  postJson(
    url: string,
    body: DebugObservabilityClientRequest,
    headers: Record<string, string>,
  ): Promise<DebugObservabilityHttpResult>;
}

export const CLIENT_RUNTIME_DEBUG_FLUSH_INTERVAL_MS = 1200;
export const CLIENT_RUNTIME_DEBUG_SNAPSHOT_INTERVAL_MS = 2500;

const MAX_PENDING_LOG_BATCHES = 8;
const MAX_PENDING_SNAPSHOTS = 2;

const lastSnapshotSentAtByTarget = new Map<string, number>();
const pendingLogBatches: DebugObservabilityLogRequest[] = [];
const pendingSnapshots: DebugObservabilitySnapshotRequest[] = [];
let flushInFlight = false;
let droppedLogBatches = 0;
let droppedSnapshots = 0;

export function resetRuntimeDebugExporterStateForTests() {
  lastSnapshotSentAtByTarget.clear();
  pendingLogBatches.length = 0;
  pendingSnapshots.length = 0;
  flushInFlight = false;
  droppedLogBatches = 0;
  droppedSnapshots = 0;
}

export function getDroppedRuntimeDebugObservabilityCount() {
  return {
    logBatches: droppedLogBatches,
    snapshots: droppedSnapshots,
  };
}

function formatDebugTargetHost(host: string) {
  const normalized = host.trim();
  return normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
}

function buildDebugHttpUrl(target: DebugObservabilityTarget, path: string) {
  const host = formatDebugTargetHost(target.targetHost);
  return `http://${host}:${target.targetPort || 3333}${path}`;
}

function buildDebugAuthHeaders(target: DebugObservabilityTarget): Record<string, string> {
  const authToken = target.targetAuthToken?.trim();
  return authToken ? { 'X-ZTerm-Token': authToken } : {};
}

function buildDebugTargetKey(target: DebugObservabilityTarget) {
  return `${target.targetHost.trim()}:${target.targetPort || 3333}`;
}

async function postObservabilityRequest(
  target: DebugObservabilityTarget,
  transport: DebugObservabilityHttpTransport,
  path: '/logs' | '/snapshot',
  body: DebugObservabilityClientRequest,
) {
  try {
    const url = buildDebugHttpUrl(target, `/debug/runtime${path}`);
    const result = await transport.postJson(url, body, {
      'Content-Type': 'application/json',
      ...buildDebugAuthHeaders(target),
    });
    if (!result.ok) {
      console.warn(`[debug-observability] ${path} rejected with HTTP ${result.status}: ${result.text}`);
    }
    return result.ok;
  } catch (error) {
    console.warn(
      `[debug-observability] ${path} unavailable: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function flushPendingObservabilityRequests(
  target: DebugObservabilityTarget,
  transport: DebugObservabilityHttpTransport,
) {
  if (flushInFlight) {
    return;
  }
  flushInFlight = true;
  try {
    while (pendingLogBatches.length > 0) {
      const request = pendingLogBatches.shift()!;
      const accepted = await postObservabilityRequest(
        target,
        transport,
        '/logs',
        { kind: 'logs', payload: request },
      );
      if (!accepted) {
        droppedLogBatches += 1;
      }
    }
    while (pendingSnapshots.length > 0) {
      const request = pendingSnapshots.shift()!;
      const accepted = await postObservabilityRequest(
        target,
        transport,
        '/snapshot',
        { kind: 'snapshot', payload: request },
      );
      if (!accepted) {
        droppedSnapshots += 1;
      }
    }
  } finally {
    flushInFlight = false;
  }
}

function enqueueLogBatch(target: DebugObservabilityTarget, transport: DebugObservabilityHttpTransport, request: DebugObservabilityLogRequest) {
  pendingLogBatches.push(request);
  if (pendingLogBatches.length > MAX_PENDING_LOG_BATCHES) {
    pendingLogBatches.shift();
    droppedLogBatches += 1;
  }
  void flushPendingObservabilityRequests(target, transport);
}

function enqueueSnapshot(target: DebugObservabilityTarget, transport: DebugObservabilityHttpTransport, request: DebugObservabilitySnapshotRequest) {
  pendingSnapshots.push(request);
  if (pendingSnapshots.length > MAX_PENDING_SNAPSHOTS) {
    pendingSnapshots.shift();
    droppedSnapshots += 1;
  }
  void flushPendingObservabilityRequests(target, transport);
}

export const defaultDebugObservabilityHttpTransport: DebugObservabilityHttpTransport = {
  async postJson(url, body, headers) {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      text,
    };
  },
};

// Force flush is disabled by default in production runtime. Enabling this
// continuously on hot paths can amplify input latency under weak network.
function isForceFlushEnabled() {
  return false;
}

export function flushRuntimeDebugLogs(input: {
  target: DebugObservabilityTarget;
  transport?: DebugObservabilityHttpTransport;
  now?: () => number;
}) {
  const debugEnabled = isRuntimeDebugEnabled();
  const pendingEntryCount = getPendingRuntimeDebugEntryCount();
  if (!debugEnabled && !isForceFlushEnabled()) {
    return false;
  }

  const target = input.target;
  if (!target || !target.targetHost?.trim()) {
    return false;
  }

  const transport = input.transport || defaultDebugObservabilityHttpTransport;
  const now = input.now?.() || Date.now();
  const targetKey = buildDebugTargetKey(target);

  const entries = drainRuntimeDebugEntries();
  if (entries.length > 0 || pendingEntryCount > 0) {
    enqueueLogBatch(target, transport, { entries });
  }

  const previousSnapshotSentAt = lastSnapshotSentAtByTarget.get(targetKey) || 0;
  if (debugEnabled && now - previousSnapshotSentAt >= CLIENT_RUNTIME_DEBUG_SNAPSHOT_INTERVAL_MS) {
    enqueueSnapshot(target, transport, {
      snapshot: collectClientDebugSnapshot({
        source: 'debug-observability-http',
        target: targetKey,
      }),
    });
    lastSnapshotSentAtByTarget.set(targetKey, now);
  }

  return true;
}
