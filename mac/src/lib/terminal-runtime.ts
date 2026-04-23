import { useSyncExternalStore } from 'react';
import type {
  ScheduleJobDraft,
  SessionScheduleState,
  BufferSyncRequestPayload,
  EditableHost,
  Host,
  PasteImagePayload,
  TerminalRenderBufferProjection,
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
}

export type TerminalRuntimeActivityMode = 'active' | 'idle';
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
};

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

function buildBufferSyncRequestPayload(snapshot: TerminalRuntimeSnapshot, viewState: TerminalRuntimeViewState, prefetch = false): BufferSyncRequestPayload {
  const buffer = snapshot.buffer.canonicalBuffer;
  const viewportRows = Math.max(1, Math.floor(viewState.viewportRows || buffer.rows || 24));
  const mode = viewState.mode === 'reading' ? 'reading' : 'follow';
  const viewportEndIndex = mode === 'follow'
    ? Math.max(0, Math.floor(buffer.viewportEndIndex || buffer.endIndex || 0))
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
  let state: TerminalRuntimeSnapshot = {
    connection: bridgeTransport.getState(),
    buffer: bufferStore.getState(),
    render: bufferStore.getState().renderBuffer,
    schedule: bridgeTransport.getScheduleState(),
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
    };
    emit();
  };

  const requestCurrentViewportSync = (prefetch = false) => {
    if (activityMode !== 'active') {
      return;
    }
    const payload = buildBufferSyncRequestPayload(state, lastViewState, prefetch);
    activeTransport.requestBufferSync(payload);
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
      bufferStore.reset();
      activeTransport = bridgeTransport;
      localTransport.disconnect();
      bridgeTransport.connect(host, {
        onServerMessage: (message) => {
          bufferStore.applyServerMessage(message);
        },
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
      bufferStore.reset();
      bridgeTransport.disconnect();
      activeTransport = localTransport;
      state = {
        ...state,
        schedule: buildEmptyScheduleState(target.sessionName),
      };
      localTransport.connect(target, {
        onServerMessage: (message) => {
          bufferStore.applyServerMessage(message);
        },
      });
    },
    disconnect: () => {
      bridgeTransport.disconnect();
      localTransport.disconnect();
    },
    setActivityMode: (mode) => {
      activityMode = mode;
      bridgeTransport.setActivityMode(mode);
      localTransport.setActivityMode(mode);
      if (mode === 'active') {
        requestCurrentViewportSync(false);
      }
    },
    updateViewport: (viewState) => {
      lastViewState = {
        mode: viewState.mode === 'reading' ? 'reading' : 'follow',
        viewportEndIndex: Math.max(0, Math.floor(viewState.viewportEndIndex || 0)),
        viewportRows: Math.max(1, Math.floor(viewState.viewportRows || 1)),
        missingRanges: normalizeMissingRanges(viewState.missingRanges),
      };
      requestCurrentViewportSync(false);
    },
    requestViewportPrefetch: (viewState) => {
      lastViewState = {
        mode: 'reading',
        viewportEndIndex: Math.max(0, Math.floor(viewState.viewportEndIndex || 0)),
        viewportRows: Math.max(1, Math.floor(viewState.viewportRows || 1)),
        missingRanges: normalizeMissingRanges(viewState.missingRanges),
      };
      requestCurrentViewportSync(true);
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
      requestCurrentViewportSync(false);
    },
    dispose: () => {
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
