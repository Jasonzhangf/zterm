import type { TerminalBufferPayload } from '../lib/types';
import type { SessionHeartbeatStore } from '../lib/session-heartbeat-store';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import {
  clearSessionPullStateEntry,
  hasActiveSessionPullState,
  settleSessionPullStatesWithBufferSync,
  type SessionPullPurpose,
  type SessionPullStates,
} from './session-pull-state-helpers';
import {
  clearPendingBufferSyncFrameAssembly,
  type BufferFrameAssemblyResourceState,
} from './session-buffer-frame-assembly';

interface MutableRefObject<T> {
  current: T;
}

interface SessionDebugMetricsRecorder {
  recordTxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
  recordRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
  recordRenderCommit: (sessionId: string) => void;
  recordRefreshRequest: (sessionId: string) => void;
}

interface RuntimeDebugFn {
  (event: string, payload?: Record<string, unknown>): void;
}

export interface RecordSessionTxOptions {
  pullPurpose?: SessionPullPurpose;
  targetHeadRevision?: number;
  targetStartIndex?: number;
  targetEndIndex?: number;
  requestKnownRevision?: number;
  requestLocalStartIndex?: number;
  requestLocalEndIndex?: number;
  repairSignature?: string;
}

export function recordSessionTx(options: {
  sessionId: string;
  data: string | ArrayBuffer;
  refs: {
    sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
    sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
  };
  recordOptions?: RecordSessionTxOptions;
}) {
  options.refs.sessionDebugMetricsStoreRef.current.recordTxBytes(options.sessionId, options.data);
  if (!options.recordOptions?.pullPurpose) {
    return;
  }

  options.refs.sessionDebugMetricsStoreRef.current.recordRefreshRequest(options.sessionId);
  const nextPullStates = {
    ...(options.refs.sessionPullStateRef.current.get(options.sessionId) || {}),
    [options.recordOptions.pullPurpose]: {
      purpose: options.recordOptions.pullPurpose,
      startedAt: Date.now(),
      targetHeadRevision: Math.max(0, Math.floor(options.recordOptions.targetHeadRevision || 0)),
      targetStartIndex: Math.max(0, Math.floor(options.recordOptions.targetStartIndex || 0)),
      targetEndIndex: Math.max(0, Math.floor(options.recordOptions.targetEndIndex || 0)),
      requestKnownRevision: Math.max(0, Math.floor(options.recordOptions.requestKnownRevision || 0)),
      requestLocalStartIndex: Math.max(0, Math.floor(options.recordOptions.requestLocalStartIndex || 0)),
      requestLocalEndIndex: Math.max(0, Math.floor(options.recordOptions.requestLocalEndIndex || 0)),
      repairSignature: typeof options.recordOptions.repairSignature === 'string'
        ? options.recordOptions.repairSignature
        : '',
    },
  } satisfies SessionPullStates;
  options.refs.sessionPullStateRef.current.set(options.sessionId, nextPullStates);
}

export function recordSessionRx(options: {
  sessionId: string;
  data: string | ArrayBuffer;
  refs: {
    sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
    heartbeatStore: SessionHeartbeatStore;
    reconnectStore: SessionReconnectStore;
  };
}) {
  const now = Date.now();
  options.refs.sessionDebugMetricsStoreRef.current.recordRxBytes(options.sessionId, options.data);
  options.refs.heartbeatStore.recordServerActivity(options.sessionId, now);
  if (isTerminalRenderActivityFrame(options.data)) {
    options.refs.heartbeatStore.recordTerminalActivity(options.sessionId, now);
    options.refs.reconnectStore.clearStaleTransportProbe(options.sessionId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isTerminalRenderActivityMessage(message: unknown): boolean {
  if (!isRecord(message) || typeof message.type !== 'string') {
    return false;
  }
  if (message.type === 'buffer-head' || message.type === 'buffer-sync') {
    return true;
  }
  if (message.type === 'mux-channel-message') {
    const payload = isRecord(message.payload) ? message.payload : null;
    return isTerminalRenderActivityMessage(payload?.message);
  }
  return false;
}

export function isTerminalRenderActivityFrame(data: string | ArrayBuffer): boolean {
  if (typeof data !== 'string') {
    return false;
  }
  try {
    return isTerminalRenderActivityMessage(JSON.parse(data) as unknown);
  } catch {
    return false;
  }
}

export function markPendingInputTailRefresh(options: {
  sessionId: string;
  localRevision: number;
  tailRefreshStore: SessionTailRefreshStore;
}) {
  return options.tailRefreshStore.markPendingInputTailRefresh(
    options.sessionId,
    options.localRevision,
  );
}

export function clearSessionPullState(options: {
  sessionId: string;
  sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
  purpose?: SessionPullPurpose;
}) {
  if (!options.purpose) {
    options.sessionPullStateRef.current.delete(options.sessionId);
    return;
  }
  const nextPullStates = clearSessionPullStateEntry(
    options.sessionPullStateRef.current.get(options.sessionId) || null,
    options.purpose,
  );
  if (!nextPullStates) {
    options.sessionPullStateRef.current.delete(options.sessionId);
    return;
  }
  options.sessionPullStateRef.current.set(options.sessionId, nextPullStates);
}

export function settleSessionPullState(options: {
  sessionId: string;
  payload: TerminalBufferPayload;
  sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
}) {
  const nextPullStates = settleSessionPullStatesWithBufferSync(
    options.sessionPullStateRef.current.get(options.sessionId) || null,
    options.payload,
  );
  if (!nextPullStates) {
    options.sessionPullStateRef.current.delete(options.sessionId);
    return;
  }
  options.sessionPullStateRef.current.set(options.sessionId, nextPullStates);
}

export function resetSessionTransportPullBookkeeping(options: {
  sessionId: string;
  reason: string;
  activeSessionId: string | null;
  sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
  tailRefreshStore: SessionTailRefreshStore;
  bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
  runtimeDebug: RuntimeDebugFn;
}) {
  const pullStates = options.sessionPullStateRef.current.get(options.sessionId) || null;
  const hadPendingInputTailRefresh = options.tailRefreshStore.hasPendingInputTailRefresh(options.sessionId);
  const hadTailRefreshDebounce = options.tailRefreshStore.hasSyncRequest(options.sessionId, 'tail-refresh');
  const hadReadingRepairDebounce = options.tailRefreshStore.hasSyncRequest(options.sessionId, 'reading-repair');
  const frameResource = options.bufferFrameAssemblyRef.current.get(options.sessionId) || null;
  const hadPendingBufferFrame = frameResource?.pending !== null && frameResource?.pending !== undefined;
  const hasLivePullBookkeeping = Boolean(pullStates && hasActiveSessionPullState(pullStates));
  if (!hasLivePullBookkeeping && !hadPendingInputTailRefresh && !hadTailRefreshDebounce && !hadReadingRepairDebounce && !hadPendingBufferFrame) {
    return;
  }
  options.runtimeDebug('session.buffer.pull.reset', {
    sessionId: options.sessionId,
    activeSessionId: options.activeSessionId,
    reason: options.reason,
    pullStates,
    hadPendingInputTailRefresh,
    hadTailRefreshDebounce,
    hadReadingRepairDebounce,
    hadPendingBufferFrame,
  });
  if (hasLivePullBookkeeping) {
    clearSessionPullState({
      sessionId: options.sessionId,
      sessionPullStateRef: options.sessionPullStateRef,
    });
  }
  options.tailRefreshStore.clearPendingInputTailRefresh(options.sessionId);
  const retainedFrameResource = clearPendingBufferSyncFrameAssembly(frameResource);
  if (retainedFrameResource) {
    options.bufferFrameAssemblyRef.current.set(options.sessionId, retainedFrameResource);
  }
  options.tailRefreshStore.clearSyncRequest(options.sessionId, 'tail-refresh');
  options.tailRefreshStore.clearSyncRequest(options.sessionId, 'reading-repair');
}

export function isSessionTransportActivityStale(options: {
  sessionId: string;
  heartbeatStore: SessionHeartbeatStore;
  staleActivityMs: number;
}) {
  const lastServerActivityAt = options.heartbeatStore.readLastServerActivityAt(options.sessionId);
  if (lastServerActivityAt <= 0) {
    return false;
  }
  return Date.now() - lastServerActivityAt > options.staleActivityMs;
}
