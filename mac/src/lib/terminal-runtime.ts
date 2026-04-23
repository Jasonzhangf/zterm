import { useSyncExternalStore } from 'react';
import type {
  ScheduleJobDraft,
  SessionScheduleState,
  BufferSyncRequestPayload,
  BufferHeadPayload,
  BridgeServerMessage,
  EditableHost,
  Host,
  PasteImagePayload,
  TerminalRenderBufferProjection,
  SessionBufferState,
} from '@zterm/shared';
import {
  buildEmptyScheduleState,
} from '@zterm/shared';
import {
  createBridgeTransportController,
  createIdleConnectionState,
  type ActiveBridgeTargetState,
  type BridgeTransportController,
  type TerminalConnectionState,
} from './bridge-transport';
import {
  createLocalTmuxTransportController,
  type LocalTmuxConnectionState,
  type LocalTmuxTransportController,
} from './local-tmux-transport';
import { createTerminalBufferStore, type TerminalBufferStore, type TerminalBufferStoreSnapshot } from './terminal-buffer-store';

export interface TerminalRuntimeSnapshot {
  connection: TerminalConnectionState | LocalTmuxConnectionState;
  buffer: TerminalBufferStoreSnapshot;
  render: TerminalRenderBufferProjection;
  schedule: SessionScheduleState;
  head: TerminalSessionHead | null;
}

export type TerminalRuntimeActivityMode = 'active' | 'idle';
export interface TerminalSessionHead {
  sessionId: string;
  revision: number;
  latestEndIndex: number;
}

export type TerminalRuntimeViewState = {
  mode: 'follow' | 'reading';
  viewportEndIndex: number;
  viewportRows: number;
  missingRanges?: Array<{ startIndex: number; endIndex: number }>;
};

export interface TerminalRuntimeController {
  getState: () => TerminalRuntimeSnapshot;
  subscribe: (listener: () => void) => () => void;
  connectRemote: (host: EditableHost | Host) => void;
  connectLocalTmux: (target: { sessionName: string; title?: string }) => void;
  disconnect: () => void;
  setActivityMode: (mode: TerminalRuntimeActivityMode) => void;
  updateViewport: (viewState: TerminalRuntimeViewState) => void;
  requestViewportPrefetch: (viewState: TerminalRuntimeViewState) => void;
  requestScheduleList: (sessionName: string) => void;
  upsertScheduleJob: (job: ScheduleJobDraft) => void;
  deleteScheduleJob: (jobId: string) => void;
  toggleScheduleJob: (jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (jobId: string) => void;
  sendInput: (data: string) => void;
  pasteImage: (payload: PasteImagePayload) => boolean;
  resizeTerminal: (cols: number, rows: number) => void;
  dispose: () => void;
}

const EMPTY_BUFFER_SNAPSHOT = createTerminalBufferStore().getState();
const EMPTY_RUNTIME_SNAPSHOT: TerminalRuntimeSnapshot = {
  connection: createIdleConnectionState(),
  buffer: EMPTY_BUFFER_SNAPSHOT,
  render: EMPTY_BUFFER_SNAPSHOT.renderBuffer,
  schedule: buildEmptyScheduleState(''),
  head: null,
};

const READING_SYNC_DELAY_MS = 24;

function buildRuntimeRequestSignature(host: EditableHost | Host) {
  return JSON.stringify({
    name: host.name,
    bridgeHost: host.bridgeHost,
    bridgePort: host.bridgePort,
    sessionName: host.sessionName,
    authToken: host.authToken || '',
    authType: host.authType,
    password: host.password || '',
    privateKey: host.privateKey || '',
    autoCommand: host.autoCommand || '',
  });
}

function normalizeMissingRanges(missingRanges: TerminalRuntimeViewState['missingRanges']) {
  return Array.isArray(missingRanges)
    ? missingRanges
        .map((range) => ({
          startIndex: Math.max(0, Math.floor(range.startIndex || 0)),
          endIndex: Math.max(0, Math.floor(range.endIndex || 0)),
        }))
        .filter((range) => range.endIndex > range.startIndex)
    : undefined;
}

function normalizeViewState(viewState: TerminalRuntimeViewState): TerminalRuntimeViewState {
  return {
    mode: viewState.mode === 'reading' ? 'reading' : 'follow',
    viewportEndIndex: Math.max(0, Math.floor(viewState.viewportEndIndex || 0)),
    viewportRows: Math.max(1, Math.floor(viewState.viewportRows || 1)),
    missingRanges: normalizeMissingRanges(viewState.missingRanges),
  };
}

function normalizeHead(payload: BufferHeadPayload): TerminalSessionHead {
  return {
    sessionId: payload.sessionId,
    revision: Math.max(0, Math.floor(payload.revision || 0)),
    latestEndIndex: Math.max(0, Math.floor(payload.latestEndIndex || 0)),
  };
}

function buildBufferSyncRequestPayload(
  snapshot: TerminalRuntimeSnapshot,
  viewState: TerminalRuntimeViewState,
  head: TerminalSessionHead | null,
  prefetch = false,
): BufferSyncRequestPayload {
  const buffer = snapshot.buffer.canonicalBuffer;
  const viewportRows = Math.max(1, Math.floor(viewState.viewportRows || buffer.rows || 24));
  const mode = viewState.mode === 'reading' ? 'reading' : 'follow';
  const viewportEndIndex = mode === 'follow'
    ? Math.max(0, Math.floor(head?.latestEndIndex || buffer.viewportEndIndex || buffer.endIndex || 0))
    : Math.max(0, Math.floor(viewState.viewportEndIndex || buffer.viewportEndIndex || buffer.endIndex || 0));

  return {
    knownRevision: Math.max(0, Math.floor(buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(buffer.endIndex || 0)),
    viewportEndIndex,
    viewportRows,
    mode,
    prefetch,
    missingRanges: normalizeMissingRanges(viewState.missingRanges),
  };
}

function bufferHasGapInRange(buffer: SessionBufferState, startIndex: number, endIndex: number) {
  return buffer.gapRanges.some((range) => range.endIndex > startIndex && range.startIndex < endIndex);
}

function shouldRequestFollowSync(
  snapshot: TerminalRuntimeSnapshot,
  head: TerminalSessionHead | null,
  viewState: TerminalRuntimeViewState,
) {
  const buffer = snapshot.buffer.canonicalBuffer;
  const viewportRows = Math.max(1, Math.floor(viewState.viewportRows || buffer.rows || 24));
  const desiredEndIndex = Math.max(0, Math.floor(head?.latestEndIndex || buffer.viewportEndIndex || buffer.endIndex || 0));
  const hotStartIndex = Math.max(0, desiredEndIndex - viewportRows * 3);

  if (head && buffer.revision < head.revision) {
    return true;
  }

  if (buffer.endIndex < desiredEndIndex) {
    return true;
  }

  if (buffer.startIndex > hotStartIndex) {
    return true;
  }

  return bufferHasGapInRange(buffer, hotStartIndex, desiredEndIndex);
}

function shouldRequestReadingSync(snapshot: TerminalRuntimeSnapshot, viewState: TerminalRuntimeViewState) {
  const buffer = snapshot.buffer.canonicalBuffer;
  const viewportRows = Math.max(1, Math.floor(viewState.viewportRows || buffer.rows || 24));
  const viewportEndIndex = Math.max(0, Math.floor(viewState.viewportEndIndex || buffer.viewportEndIndex || buffer.endIndex || 0));
  const viewportStartIndex = Math.max(0, viewportEndIndex - viewportRows);

  if ((viewState.missingRanges || []).length > 0) {
    return true;
  }

  if (buffer.startIndex > viewportStartIndex) {
    return true;
  }

  if (buffer.endIndex < viewportEndIndex) {
    return true;
  }

  return bufferHasGapInRange(buffer, viewportStartIndex, viewportEndIndex);
}

export function createTerminalRuntime(): TerminalRuntimeController {
  const bridgeTransport = createBridgeTransportController();
  const localTransport = createLocalTmuxTransportController();
  const bufferStore = createTerminalBufferStore();
  const listeners = new Set<() => void>();
  let lastRequestedSignature = '';
  let activeTransport: BridgeTransportController | LocalTmuxTransportController = bridgeTransport;
  let activityMode: TerminalRuntimeActivityMode = 'active';
  let lastViewState: TerminalRuntimeViewState = {
    mode: 'follow',
    viewportEndIndex: 0,
    viewportRows: 24,
  };
  let head: TerminalSessionHead | null = null;
  let readingSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let lastBufferSyncKey = '';
  let state: TerminalRuntimeSnapshot = {
    connection: bridgeTransport.getState(),
    buffer: bufferStore.getState(),
    render: bufferStore.getState().renderBuffer,
    schedule: bridgeTransport.getScheduleState(),
    head: null,
  };

  const emit = () => {
    listeners.forEach((listener) => listener());
  };

  const syncState = () => {
    const buffer = bufferStore.getState();
    state = {
      connection: activeTransport.getState() as TerminalConnectionState | LocalTmuxConnectionState,
      buffer,
      render: buffer.renderBuffer,
      schedule: activeTransport === bridgeTransport ? bridgeTransport.getScheduleState() : buildEmptyScheduleState(''),
      head,
    };
    emit();
  };

  const clearQueuedReadingSync = () => {
    if (readingSyncTimer) {
      clearTimeout(readingSyncTimer);
      readingSyncTimer = null;
    }
  };

  const requestCurrentViewportSync = (options?: { prefetch?: boolean; force?: boolean; reason?: string }) => {
    if (activityMode !== 'active') {
      return false;
    }
    const payload = buildBufferSyncRequestPayload(state, lastViewState, head, Boolean(options?.prefetch));
    const key = JSON.stringify(payload);
    if (!options?.force && key === lastBufferSyncKey) {
      return false;
    }
    void options?.reason;
    lastBufferSyncKey = key;
    activeTransport.requestBufferSync(payload);
    return true;
  };

  const scheduleReadingViewportSync = () => {
    clearQueuedReadingSync();
    readingSyncTimer = setTimeout(() => {
      readingSyncTimer = null;
      if (shouldRequestReadingSync(state, lastViewState)) {
        requestCurrentViewportSync({ reason: 'reading-viewport' });
      }
    }, READING_SYNC_DELAY_MS);
  };

  const applyViewportDemand = () => {
    if (activityMode !== 'active') {
      return;
    }
    if (lastViewState.mode === 'reading') {
      scheduleReadingViewportSync();
      return;
    }
    clearQueuedReadingSync();
    if (shouldRequestFollowSync(state, head, lastViewState)) {
      requestCurrentViewportSync({ reason: 'follow-demand' });
    }
  };

  const handleServerMessage = (message: BridgeServerMessage) => {
    if (message.type === 'connected') {
      lastBufferSyncKey = '';
      requestCurrentViewportSync({ force: true, reason: 'connected-bootstrap' });
      return;
    }

    if (message.type === 'buffer-head') {
      head = normalizeHead(message.payload);
      syncState();
      if (lastViewState.mode === 'follow') {
        applyViewportDemand();
      }
      return;
    }

    const applied = bufferStore.applyServerMessage(message);
    if (applied && lastViewState.mode === 'follow' && shouldRequestFollowSync(state, head, lastViewState)) {
      requestCurrentViewportSync({ reason: 'follow-catchup' });
    }
  };

  const unsubscribeBridgeTransport = bridgeTransport.subscribe(syncState);
  const unsubscribeLocalTransport = localTransport.subscribe(syncState);
  const unsubscribeBuffer = bufferStore.subscribe(syncState);

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connectRemote: (host) => {
      const nextSignature = buildRuntimeRequestSignature(host);
      const currentConnection = bridgeTransport.getState();
      if (
        nextSignature
        && nextSignature === lastRequestedSignature
        && (currentConnection.status === 'connecting' || currentConnection.status === 'connected')
      ) {
        return;
      }
      lastRequestedSignature = nextSignature;
      lastBufferSyncKey = '';
      head = null;
      clearQueuedReadingSync();
      activeTransport = bridgeTransport;
      bufferStore.reset();
      localTransport.disconnect();
      bridgeTransport.connect(host, {
        onServerMessage: handleServerMessage,
      });
    },
    connectLocalTmux: (target) => {
      const nextSignature = JSON.stringify({ localTmux: target.sessionName });
      const currentConnection = localTransport.getState();
      if (
        nextSignature
        && nextSignature === lastRequestedSignature
        && (currentConnection.status === 'connecting' || currentConnection.status === 'connected')
      ) {
        return;
      }
      lastRequestedSignature = nextSignature;
      lastBufferSyncKey = '';
      head = null;
      clearQueuedReadingSync();
      bridgeTransport.disconnect();
      activeTransport = localTransport;
      bufferStore.reset();
      state = {
        ...state,
        schedule: buildEmptyScheduleState(target.sessionName),
        head: null,
      };
      localTransport.connect(target, {
        onServerMessage: handleServerMessage,
      });
    },
    disconnect: () => {
      clearQueuedReadingSync();
      head = null;
      lastBufferSyncKey = '';
      bridgeTransport.disconnect();
      localTransport.disconnect();
      syncState();
    },
    setActivityMode: (mode) => {
      activityMode = mode;
      bridgeTransport.setActivityMode(mode);
      localTransport.setActivityMode(mode);
      if (mode === 'active') {
        applyViewportDemand();
        return;
      }
      clearQueuedReadingSync();
    },
    updateViewport: (viewState) => {
      const normalizedViewState = normalizeViewState(viewState);
      const previousKey = JSON.stringify(lastViewState);
      const nextKey = JSON.stringify(normalizedViewState);
      if (previousKey === nextKey) {
        return;
      }
      lastViewState = normalizedViewState;
      applyViewportDemand();
    },
    requestViewportPrefetch: (viewState) => {
      lastViewState = normalizeViewState({
        ...viewState,
        mode: 'reading',
      });
      if (shouldRequestReadingSync(state, lastViewState)) {
        requestCurrentViewportSync({ prefetch: true, reason: 'reading-prefetch' });
      }
    },
    requestScheduleList: (sessionName) => {
      bridgeTransport.requestScheduleList(sessionName);
    },
    upsertScheduleJob: (job) => {
      bridgeTransport.upsertScheduleJob(job);
    },
    deleteScheduleJob: (jobId) => {
      bridgeTransport.deleteScheduleJob(jobId);
    },
    toggleScheduleJob: (jobId, enabled) => {
      bridgeTransport.toggleScheduleJob(jobId, enabled);
    },
    runScheduleJobNow: (jobId) => {
      bridgeTransport.runScheduleJobNow(jobId);
    },
    sendInput: (data) => {
      activeTransport.sendInput(data);
    },
    pasteImage: (payload) => activeTransport.pasteImage(payload),
    resizeTerminal: (cols, rows) => {
      activeTransport.resizeTerminal(cols, rows);
      lastViewState = {
        ...lastViewState,
        viewportRows: Math.max(1, Math.floor(rows || lastViewState.viewportRows || 24)),
      };
      applyViewportDemand();
    },
    dispose: () => {
      clearQueuedReadingSync();
      unsubscribeBridgeTransport();
      unsubscribeLocalTransport();
      unsubscribeBuffer();
      bridgeTransport.dispose();
      localTransport.dispose();
      listeners.clear();
    },
  };
}

function subscribeNoop() {
  return () => {};
}

function getEmptySnapshot() {
  return EMPTY_RUNTIME_SNAPSHOT;
}

export function useTerminalRuntimeSnapshot(runtime: TerminalRuntimeController | null | undefined) {
  return useSyncExternalStore(
    runtime ? runtime.subscribe : subscribeNoop,
    runtime ? runtime.getState : getEmptySnapshot,
    getEmptySnapshot,
  );
}

export type { ActiveBridgeTargetState, TerminalConnectionState, BridgeTransportController, TerminalBufferStore };
