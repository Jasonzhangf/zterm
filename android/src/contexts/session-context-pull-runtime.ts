import type { TerminalBufferPayload } from '../lib/types';
import {
  clearSessionPullStateEntry,
  hasActiveSessionPullState,
  settleSessionPullStatesWithBufferSync,
  type SessionPullPurpose,
  type SessionPullStates,
} from './session-sync-helpers';

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
    },
  } satisfies SessionPullStates;
  options.refs.sessionPullStateRef.current.set(options.sessionId, nextPullStates);
}

export function recordSessionRx(options: {
  sessionId: string;
  data: string | ArrayBuffer;
  refs: {
    sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
    lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
    staleTransportProbeAtRef: MutableRefObject<Map<string, number>>;
  };
}) {
  options.refs.sessionDebugMetricsStoreRef.current.recordRxBytes(options.sessionId, options.data);
  options.refs.lastServerActivityAtRef.current.set(options.sessionId, Date.now());
  options.refs.staleTransportProbeAtRef.current.delete(options.sessionId);
}

export function recordSessionRenderCommit(options: {
  sessionId: string;
  sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsRecorder>;
}) {
  options.sessionDebugMetricsStoreRef.current.recordRenderCommit(options.sessionId);
}

export function markPendingInputTailRefresh(options: {
  sessionId: string;
  localRevision: number;
  pendingInputTailRefreshRef: MutableRefObject<Map<string, { requestedAt: number; localRevision: number }>>;
}) {
  options.pendingInputTailRefreshRef.current.set(options.sessionId, {
    requestedAt: Date.now(),
    localRevision: Math.max(0, Math.floor(options.localRevision || 0)),
  });
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
  runtimeDebug: RuntimeDebugFn;
}) {
  const pullStates = options.sessionPullStateRef.current.get(options.sessionId) || null;
  if (!pullStates || !hasActiveSessionPullState(pullStates)) {
    return;
  }
  options.runtimeDebug('session.buffer.pull.reset', {
    sessionId: options.sessionId,
    activeSessionId: options.activeSessionId,
    reason: options.reason,
    pullStates,
  });
  clearSessionPullState({
    sessionId: options.sessionId,
    sessionPullStateRef: options.sessionPullStateRef,
  });
}

export function isSessionTransportActivityStale(options: {
  sessionId: string;
  lastServerActivityAtRef: MutableRefObject<Map<string, number>>;
  staleActivityMs: number;
}) {
  const lastServerActivityAt = options.lastServerActivityAtRef.current.get(options.sessionId) || 0;
  if (lastServerActivityAt <= 0) {
    return false;
  }
  return Date.now() - lastServerActivityAt > options.staleActivityMs;
}
