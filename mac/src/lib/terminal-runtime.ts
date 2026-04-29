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
import type { RemoteScreenshotStatusPayload } from '@zterm/shared';
import { buildEmptyScheduleState } from '@zterm/shared';
import {
  createBridgeTransportController,
  createIdleConnectionState,
  type ActiveBridgeTargetState,
  type BridgeTransportController,
  type TerminalConnectionState,
  type RemoteScreenshotRequestOptions,
} from './bridge-transport';
import {
  createLocalTmuxTransportController,
  type LocalTmuxConnectionState,
  type LocalTmuxTransportController,
} from './local-tmux-transport';
import { createTerminalBufferStore, type TerminalBufferStore, type TerminalBufferStoreSnapshot } from './terminal-buffer-store';

export interface TerminalRuntimeState {
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
  availableStartIndex?: number;
  availableEndIndex?: number;
}

export type TerminalRuntimeViewState = {
  mode: 'follow' | 'reading';
  viewportEndIndex: number;
  viewportRows: number;
  missingRanges?: Array<{ startIndex: number; endIndex: number }>;
};

type RuntimeSyncState = {
  buffer: SessionBufferState;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
};

export interface TerminalRuntimeController {
  getState: () => TerminalRuntimeState;
  subscribe: (listener: () => void) => () => void;
  connectRemote: (host: EditableHost | Host) => void;
  connectLocalTmux: (target: { sessionName: string; title?: string }) => void;
  disconnect: () => void;
  setActivityMode: (mode: TerminalRuntimeActivityMode) => void;
  updateViewport: (viewState: TerminalRuntimeViewState) => void;
  requestScheduleList: (sessionName: string) => void;
  upsertScheduleJob: (job: ScheduleJobDraft) => void;
  deleteScheduleJob: (jobId: string) => void;
  toggleScheduleJob: (jobId: string, enabled: boolean) => void;
  runScheduleJobNow: (jobId: string) => void;
  sendInput: (data: string) => void;
  pasteImage: (payload: PasteImagePayload) => boolean;
  resizeTerminal: (cols: number, rows: number) => void;
  requestRemoteScreenshot: (opts: RemoteScreenshotRequestOptions) => boolean;
  sendRawJson: (message: unknown) => boolean;
  onFileTransferMessage: (handler: (msg: unknown) => void) => () => void;
  dispose: () => void;
}

const EMPTY_BUFFER_SNAPSHOT = createTerminalBufferStore().getState();
const EMPTY_RUNTIME_STATE: TerminalRuntimeState = {
  connection: createIdleConnectionState(),
  buffer: EMPTY_BUFFER_SNAPSHOT,
  render: EMPTY_BUFFER_SNAPSHOT.renderBuffer,
  schedule: buildEmptyScheduleState(''),
  head: null,
};

const HEAD_TICK_MS = 33;
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

function bufferHasGapInRange(
  buffer: SessionBufferState,
  startIndex: number,
  endIndex: number,
) {
  return buffer.gapRanges.some((range) => range.endIndex > startIndex && range.startIndex < endIndex);
}

function shouldPullFollowBuffer(
  state: RuntimeSyncState,
  renderDemand?: TerminalRuntimeViewState,
) {
  const buffer = state.buffer;
  const viewportRows = Math.max(1, Math.floor(renderDemand?.viewportRows || buffer.rows || 24));
  const desiredEndIndex = Math.max(0, Math.floor(
    state.daemonHeadEndIndex
    || renderDemand?.viewportEndIndex
    || buffer.bufferTailEndIndex
    || buffer.endIndex
    || 0,
  ));
  const hotStartIndex = Math.max(
    Math.floor(buffer.bufferHeadStartIndex || 0),
    desiredEndIndex - viewportRows * 3,
  );
  const daemonRevision = Math.max(0, Math.floor(state.daemonHeadRevision || 0));
  const localRevision = Math.max(0, Math.floor(buffer.revision || 0));

  if (daemonRevision > localRevision) {
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

function shouldPullReadingBuffer(
  state: RuntimeSyncState,
  renderDemand?: TerminalRuntimeViewState,
) {
  const buffer = state.buffer;
  const viewportRows = Math.max(1, Math.floor(renderDemand?.viewportRows || buffer.rows || 24));
  const viewportEndIndex = Math.max(0, Math.floor(
    renderDemand?.viewportEndIndex
    || buffer.bufferTailEndIndex
    || buffer.endIndex
    || 0,
  ));
  const viewportStartIndex = Math.max(
    Math.floor(buffer.bufferHeadStartIndex || 0),
    viewportEndIndex - viewportRows,
  );
  const missingRanges = normalizeMissingRanges(renderDemand?.missingRanges) || [];

  if (missingRanges.length > 0) {
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

function normalizeHead(payload: BufferHeadPayload): TerminalSessionHead {
  return {
    sessionId: payload.sessionId,
    revision: Math.max(0, Math.floor(payload.revision || 0)),
    latestEndIndex: Math.max(0, Math.floor(payload.latestEndIndex || 0)),
    availableStartIndex: Number.isFinite(payload.availableStartIndex)
      ? Math.max(0, Math.floor(payload.availableStartIndex || 0))
      : undefined,
    availableEndIndex: Number.isFinite(payload.availableEndIndex)
      ? Math.max(0, Math.floor(payload.availableEndIndex || 0))
      : undefined,
  };
}

function buildWorkerSyncState(state: TerminalRuntimeState, head: TerminalSessionHead | null): RuntimeSyncState {
  return {
    buffer: state.buffer.canonicalBuffer,
    daemonHeadRevision: head?.revision,
    daemonHeadEndIndex: head?.latestEndIndex,
  };
}

function resolveRequestedBufferWindow(
  endIndex: number,
  viewportRows: number,
  minStartIndex = 0,
) {
  const safeViewportRows = Math.max(1, Math.floor(viewportRows || 1));
  const safeEndIndex = Math.max(0, Math.floor(endIndex || 0));
  const safeMinStartIndex = Math.max(0, Math.floor(minStartIndex || 0));
  const cacheLines = Math.max(safeViewportRows, safeViewportRows * 3);
  const requestEndIndex = Math.max(safeMinStartIndex, safeEndIndex);
  const requestStartIndex = Math.max(safeMinStartIndex, requestEndIndex - cacheLines);
  return {
    requestStartIndex,
    requestEndIndex,
  };
}

function buildBufferSyncRequestPayload(
  state: TerminalRuntimeState,
  viewState: TerminalRuntimeViewState,
  head: TerminalSessionHead | null,
): BufferSyncRequestPayload {
  const buffer = state.buffer.canonicalBuffer;
  const viewportRows = Math.max(1, Math.floor(viewState.viewportRows || buffer.rows || 24));
  const mode = viewState.mode === 'reading' ? 'reading' : 'follow';
  const viewportEndIndex = mode === 'follow'
    ? Math.max(0, Math.floor(head?.latestEndIndex || buffer.bufferTailEndIndex || buffer.endIndex || 0))
    : Math.max(0, Math.floor(viewState.viewportEndIndex || buffer.bufferTailEndIndex || buffer.endIndex || 0));
  const requestedWindow = resolveRequestedBufferWindow(
    viewportEndIndex,
    viewportRows,
    buffer.bufferHeadStartIndex,
  );

  return {
    knownRevision: Math.max(0, Math.floor(buffer.revision || 0)),
    localStartIndex: Math.max(0, Math.floor(buffer.startIndex || 0)),
    localEndIndex: Math.max(0, Math.floor(buffer.endIndex || 0)),
    requestStartIndex: requestedWindow.requestStartIndex,
    requestEndIndex: requestedWindow.requestEndIndex,
    missingRanges: normalizeMissingRanges(viewState.missingRanges),
  };
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
  let headTickTimer: ReturnType<typeof setInterval> | null = null;
  let lastHeadRequestAt = 0;
  let lastBufferSyncKey = '';
  let state: TerminalRuntimeState = {
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

  const stopHeadTick = () => {
    if (headTickTimer) {
      clearInterval(headTickTimer);
      headTickTimer = null;
    }
  };

  const requestCurrentHead = (options?: { force?: boolean }) => {
    if (activityMode !== 'active') {
      return false;
    }
    const connection = activeTransport.getState();
    if (connection.status !== 'connected' && connection.status !== 'connecting') {
      return false;
    }
    const now = Date.now();
    if (!options?.force && now - lastHeadRequestAt < HEAD_TICK_MS) {
      return false;
    }
    lastHeadRequestAt = now;
    activeTransport.requestBufferHead();
    return true;
  };

  const startHeadTick = () => {
    stopHeadTick();
    if (activityMode !== 'active') {
      return;
    }
    headTickTimer = setInterval(() => {
      void requestCurrentHead();
    }, HEAD_TICK_MS);
  };

  const requestCurrentViewportSync = (options?: { force?: boolean }) => {
    if (activityMode !== 'active') {
      return false;
    }
    const payload = buildBufferSyncRequestPayload(state, lastViewState, head);
    const key = JSON.stringify(payload);
    if (!options?.force && key === lastBufferSyncKey) {
      return false;
    }
    lastBufferSyncKey = key;
    activeTransport.requestBufferSync(payload);
    return true;
  };

  const scheduleReadingViewportSync = () => {
    clearQueuedReadingSync();
    readingSyncTimer = setTimeout(() => {
      readingSyncTimer = null;
      const demandState = buildWorkerSyncState(state, head);
      if (shouldPullReadingBuffer(demandState, lastViewState)) {
        requestCurrentViewportSync();
      }
    }, READING_SYNC_DELAY_MS);
  };

  const applyViewportDemand = () => {
    if (activityMode !== 'active') {
      return;
    }
    const demandState = buildWorkerSyncState(state, head);
    if (lastViewState.mode === 'reading') {
      scheduleReadingViewportSync();
      return;
    }
    clearQueuedReadingSync();
    if (shouldPullFollowBuffer(demandState, lastViewState)) {
      requestCurrentViewportSync();
    }
  };

  const handleServerMessage = (message: BridgeServerMessage) => {
    if (message.type === 'connected') {
      lastBufferSyncKey = '';
      requestCurrentHead({ force: true });
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
    if (applied && lastViewState.mode === 'follow') {
      const demandState = buildWorkerSyncState(state, head);
      if (shouldPullFollowBuffer(demandState, lastViewState)) {
        requestCurrentViewportSync();
      }
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
      lastHeadRequestAt = 0;
      head = null;
      clearQueuedReadingSync();
      activeTransport = bridgeTransport;
      bufferStore.reset();
      localTransport.disconnect();
      bridgeTransport.connect(host, {
        onServerMessage: handleServerMessage,
      });
      startHeadTick();
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
      lastHeadRequestAt = 0;
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
      startHeadTick();
    },
    disconnect: () => {
      clearQueuedReadingSync();
      stopHeadTick();
      head = null;
      lastHeadRequestAt = 0;
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
        startHeadTick();
        requestCurrentHead({ force: true });
        applyViewportDemand();
        return;
      }
      stopHeadTick();
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
      requestCurrentHead({ force: true });
    },
    pasteImage: (payload) => activeTransport.pasteImage(payload),
    resizeTerminal: (cols, rows) => {
      activeTransport.resizeTerminal(cols, rows);
      lastViewState = {
        ...lastViewState,
        viewportRows: Math.max(1, Math.floor(rows || lastViewState.viewportRows || 24)),
      };
      lastBufferSyncKey = '';
      requestCurrentHead({ force: true });
      applyViewportDemand();
    },
    requestRemoteScreenshot: (opts) => {
      if (activeTransport !== bridgeTransport) {
        opts.onError(new Error('Remote screenshot only available for bridge connections'));
        return false;
      }
      return bridgeTransport.requestRemoteScreenshot(opts);
    },
    sendRawJson: (message) => {
      return bridgeTransport.sendRawJson(message);
    },
    onFileTransferMessage: (handler) => {
      return bridgeTransport.onFileTransferMessage(handler);
    },
    dispose: () => {
      clearQueuedReadingSync();
      stopHeadTick();
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
  return EMPTY_RUNTIME_STATE;
}

export function useTerminalRuntimeState(runtime: TerminalRuntimeController | null | undefined) {
  return useSyncExternalStore(
    runtime ? runtime.subscribe : subscribeNoop,
    runtime ? runtime.getState : getEmptySnapshot,
    getEmptySnapshot,
  );
}

export type { ActiveBridgeTargetState, TerminalConnectionState, BridgeTransportController, TerminalBufferStore };
