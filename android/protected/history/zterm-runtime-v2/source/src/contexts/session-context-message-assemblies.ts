import { runtimeDebug } from '../lib/runtime-debug';
import type { MutableRefObject } from 'react';
import type {
  Host,
  ServerMessage,
  Session,
  SessionBufferState,
  SessionScheduleState,
  TerminalBufferPayload,
  TerminalCursorState,
} from '../lib/types';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { SessionBufferStoreCommitOptions } from '../lib/session-buffer-store';
import type { SessionHeartbeatStore } from '../lib/session-heartbeat-store';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { RevisionResetExpectation } from './session-context-core';
import type { SessionBufferHeadState } from './session-buffer-planner-helpers';
import {
  applyIncomingBufferSyncRuntime,
  handleBufferHeadRuntime,
  requestSessionBufferHeadRuntime,
  requestSessionBufferSyncRuntime,
  type BufferFrameAssemblyResourceState,
} from './session-context-buffer-runtime';
import {
  finalizeSocketFailureBaselineRuntime,
  handleSocketConnectedBaselineRuntime,
  handleSocketServerMessageRuntime,
} from './session-context-socket-message-runtime';
import type { SessionPullPurpose, SessionPullStates } from '../lib/session-pull-state-helpers';
import type { SessionVisibleRangeState, SessionDaemonHeadView } from './session-visible-range-helpers';
import type { RemoteWindowMessageRuntime } from '../lib/remote-window-message-runtime';
import type { FileTransferMessageRuntime } from '../lib/file-transfer-message-runtime';
import type { ImagePasteWaiterRuntime } from './session-context-transfer-runtime';

interface MessageAssemblyState {
  sessions: Session[];
  activeSessionId: string | null;
}

interface MessageAssemblyBufferStore {
  commitBuffer: (sessionId: string, buffer: SessionBufferState, options?: SessionBufferStoreCommitOptions) => boolean;
}

interface MessageAssemblyHeadStore {
  setHead?: (sessionId: string, head: { daemonHeadRevision: number; daemonHeadEndIndex: number }) => boolean;
  setLiveHead: (
    sessionId: string,
    head: SessionBufferHeadState,
    options?: { publishRenderer?: boolean },
  ) => boolean;
  getLiveHead: (sessionId: string) => SessionBufferHeadState | null;
  clearLiveHead?: (sessionId: string) => void;
}

interface MessageAssemblyDebugMetricsStore {
  recordRefreshRequest: (sessionId: string) => void;
}

interface MessageAssemblyFileTransferRuntime {
  dispatch: FileTransferMessageRuntime['dispatch'];
}

interface MessageAssemblyRemoteWindowRuntime {
  dispatch: RemoteWindowMessageRuntime['dispatch'];
}

export function summarizeBufferPayload(payload: TerminalBufferPayload) {
  const firstLine = payload.lines[0];
  const lastLine = payload.lines[payload.lines.length - 1];
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    generatedAt: payload.generatedAt ?? null,
    requestSentAt: payload.requestSentAt ?? null,
    frameStartIndex: payload.frameStartIndex ?? null,
    frameEndIndex: payload.frameEndIndex ?? null,
    frameChunkIndex: payload.frameChunkIndex ?? null,
    frameChunkCount: payload.frameChunkCount ?? null,
    cols: payload.cols,
    rows: payload.rows,
    lineCount: payload.lines.length,
    cursor: payload.cursor
      ? {
          rowIndex: payload.cursor.rowIndex,
          col: payload.cursor.col,
          visible: payload.cursor.visible,
        }
      : null,
    firstLineIndex: firstLine ? ('i' in firstLine ? firstLine.i : firstLine.index) : null,
    lastLineIndex: lastLine ? ('i' in lastLine ? lastLine.i : lastLine.index) : null,
  };
}

export interface SessionMessageAssembliesOptions {
  stateRef: MutableRefObject<MessageAssemblyState>;
  scheduleStatesRef: MutableRefObject<Record<string, SessionScheduleState>>;
  sessionVisibleRangeRef: MutableRefObject<Map<string, SessionVisibleRangeState>>;
  sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
  sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
  sessionBufferStoreRef: MutableRefObject<MessageAssemblyBufferStore>;
  sessionHeadStoreRef: MutableRefObject<MessageAssemblyHeadStore>;
  sessionDebugMetricsStoreRef: MutableRefObject<MessageAssemblyDebugMetricsStore>;
  tailRefreshStore: SessionTailRefreshStore;
  lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
  reconnectStore: SessionReconnectStore;
  heartbeatStore: SessionHeartbeatStore;
  lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
  connectedBaselineBurstGuardRef: MutableRefObject<Set<string>>;
  bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  fileTransferMessageRuntimeRef: MutableRefObject<MessageAssemblyFileTransferRuntime>;
  remoteWindowMessageRuntimeRef: MutableRefObject<MessageAssemblyRemoteWindowRuntime>;
  imagePasteWaiterRuntimeRef: MutableRefObject<ImagePasteWaiterRuntime>;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource?: (sessionId: string) => SessionTransportResource;
  daemonConnection: ClientDaemonConnection;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, options?: SessionSocketPayloadOptions) => void;
  clearSessionPullState: (sessionId: string, purpose?: SessionPullPurpose) => void;
  settleSessionPullState: (sessionId: string, payload: TerminalBufferPayload) => void;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer: (sessionId: string) => boolean;
  resolveSessionCacheLines: (rows?: number | null) => number;
  resolveTerminalRefreshCadence: (sessionId?: string | null) => {
    headTickMs: number;
    pullRequestStaleMs: number;
    minTailRefreshGapMs: number;
    readingSyncDelayMs: number;
  };
  setScheduleStateForSession: (sessionId: string, nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState)) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  incrementConnectedSync: () => void;
  recordRelayHostConnection?: (daemonHostId: string) => void;
  handleAttachmentError?: (message: string, code?: string) => void;
}

export interface SessionSocketPayloadOptions {
  pullPurpose?: SessionPullPurpose;
  targetHeadRevision?: number;
  targetStartIndex?: number;
  targetEndIndex?: number;
  requestKnownRevision?: number;
  requestLocalStartIndex?: number;
  requestLocalEndIndex?: number;
  repairSignature?: string;
}

export interface SessionBufferSyncRequestOptions {
  ws?: BridgeTransportSocket | null;
  reason?: string;
  purpose?: SessionPullPurpose;
  headOverride?: SessionDaemonHeadView | null;
  liveHead?: SessionBufferHeadState | null;
  invalidLocalWindow?: boolean;
  requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
  requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
}

export interface SessionSocketServerMessageOptions {
  sessionId: string;
  host: Host;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  rawFrameBytes?: number;
  onConnected: () => void;
  onFailure: (message: string, retryable: boolean) => void;
  onClosed: (reason?: string) => void;
}

export interface SessionSocketConnectedBaselineOptions {
  sessionId: string;
  sessionName: string;
  ws: BridgeTransportSocket;
}

export interface SessionSocketFailureBaselineOptions {
  sessionId: string;
  message: string;
  markCompleted: () => boolean;
}

export interface SessionSocketFailureBaselineResult {
  shouldContinue: boolean;
  manualClosed: boolean;
}

export interface SessionMessageAssembliesResult {
  requestSessionBufferSync: (sessionId: string, requestOptions?: SessionBufferSyncRequestOptions) => boolean;
  requestSessionBufferHead: (
    sessionId: string,
    ws?: BridgeTransportSocket | null,
    headOptions?: { force?: boolean; trackProbe?: boolean },
  ) => boolean;
  handleSocketServerMessage: (messageOptions: SessionSocketServerMessageOptions, msg: ServerMessage) => void;
  handleSocketConnectedBaseline: (connectedOptions: SessionSocketConnectedBaselineOptions) => void;
  finalizeSocketFailureBaseline: (baselineOptions: SessionSocketFailureBaselineOptions) => SessionSocketFailureBaselineResult;
}

export function createSessionMessageAssemblies(
  options: SessionMessageAssembliesOptions,
): SessionMessageAssembliesResult {
  const daemonConnection = options.daemonConnection;
  const tailRefreshStoreRef = { current: options.tailRefreshStore };

  const commitSessionBufferUpdate = (
    sessionId: string,
    nextBuffer: SessionBufferState,
    commitOptions?: SessionBufferStoreCommitOptions,
  ) => {
    return options.sessionBufferStoreRef.current.commitBuffer(sessionId, nextBuffer, commitOptions);
  };

  const requestSessionBufferSync = (sessionId: string, requestOptions?: SessionBufferSyncRequestOptions) => requestSessionBufferSyncRuntime({
    sessionId,
    requestOptions,
    refs: {
      stateRef: options.stateRef,
      sessionVisibleRangeRef: options.sessionVisibleRangeRef,
      sessionHeadStoreRef: options.sessionHeadStoreRef,
      sessionPullStateRef: options.sessionPullStateRef,
      tailRefreshStoreRef,
    },
    daemonConnection,
    readSessionTransportSocket: options.readSessionTransportSocket,
    readSessionTransportResource: options.readSessionTransportResource,
    readSessionBufferSnapshot: options.readSessionBufferSnapshot,
    clearSessionPullState: options.clearSessionPullState,
    sendSocketPayload: options.sendSocketPayload,
    runtimeDebug,
    resolveTerminalRefreshCadence: () => options.resolveTerminalRefreshCadence(sessionId),
  });

  const requestSessionBufferHead = (
    sessionId: string,
    ws?: BridgeTransportSocket | null,
    headOptions?: { force?: boolean; trackProbe?: boolean },
  ) => requestSessionBufferHeadRuntime({
    sessionId,
    ws,
    force: headOptions?.force,
    trackProbe: headOptions?.trackProbe,
    refs: {
      stateRef: options.stateRef,
      lastHeadRequestAtRef: options.lastHeadRequestAtRef,
      reconnectStore: options.reconnectStore,
      sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
    },
    daemonConnection,
    readSessionTransportSocket: options.readSessionTransportSocket,
    readSessionTransportResource: options.readSessionTransportResource,
    sendSocketPayload: options.sendSocketPayload,
    resolveTerminalRefreshCadence: () => options.resolveTerminalRefreshCadence(sessionId),
  });

  const handleBufferHead = (
    sessionId: string,
    latestRevision: number,
    latestEndIndex: number,
    availableStartIndex?: number,
    availableEndIndex?: number,
    cursor?: TerminalCursorState | null,
    cursorKeysApp?: boolean,
  ) => {
    handleBufferHeadRuntime({
      sessionId,
      latestRevision,
      latestEndIndex,
      availableStartIndex,
      availableEndIndex,
      cursor,
      cursorKeysApp,
      refs: {
        stateRef: options.stateRef,
        lastHeadRequestAtRef: options.lastHeadRequestAtRef,
        tailRefreshStoreRef,
        sessionRevisionResetRef: options.sessionRevisionResetRef,
        sessionVisibleRangeRef: options.sessionVisibleRangeRef,
        sessionBufferStoreRef: options.sessionBufferStoreRef,
        bufferFrameAssemblyRef: options.bufferFrameAssemblyRef,
        sessionHeadStoreRef: options.sessionHeadStoreRef,
      },
      daemonConnection,
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionTransportResource: options.readSessionTransportResource,
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit: options.scheduleSessionRenderCommit,
      isSessionTransportActive: options.isSessionTransportActive,
      shouldAcceptSessionLiveBuffer: options.shouldAcceptSessionLiveBuffer,
      runtimeDebug,
      requestSessionBufferSync,
    });
  };

  const applyIncomingBufferSync = (sessionId: string, payload: TerminalBufferPayload) => {
    applyIncomingBufferSyncRuntime({
      sessionId,
      payload,
      refs: {
        stateRef: options.stateRef,
        sessionRevisionResetRef: options.sessionRevisionResetRef,
        sessionHeadStoreRef: options.sessionHeadStoreRef,
        tailRefreshStoreRef,
        bufferFrameAssemblyRef: options.bufferFrameAssemblyRef,
        sessionVisibleRangeRef: options.sessionVisibleRangeRef,
      },
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      resolveSessionCacheLines: options.resolveSessionCacheLines,
      summarizeBufferPayload,
      runtimeDebug,
      commitSessionBufferUpdate,
      scheduleSessionRenderCommit: options.scheduleSessionRenderCommit,
      isSessionTransportActive: options.isSessionTransportActive,
      shouldAcceptSessionLiveBuffer: options.shouldAcceptSessionLiveBuffer,
      requestSessionBufferSync,
    });
  };

  const handleSocketServerMessage = (
    messageOptions: SessionSocketServerMessageOptions,
    msg: ServerMessage,
  ) => {
    handleSocketServerMessageRuntime({
      params: messageOptions,
      msg,
      refs: {
        stateRef: options.stateRef,
        scheduleStatesRef: options.scheduleStatesRef,
        lastHeadRequestAtRef: options.lastHeadRequestAtRef,
        heartbeatStore: options.heartbeatStore,
      },
      settleSessionPullState: options.settleSessionPullState,
      runtimeDebug,
      isSessionTransportActive: options.isSessionTransportActive,
      shouldAcceptSessionLiveBuffer: options.shouldAcceptSessionLiveBuffer,
      summarizeBufferPayload,
      applyIncomingBufferSync,
      handleBufferHead,
      setScheduleStateForSession: options.setScheduleStateForSession,
      setSessionTitleSync: options.setSessionTitleSync,
      fileTransferMessageRuntime: options.fileTransferMessageRuntimeRef.current,
      remoteWindowMessageRuntime: options.remoteWindowMessageRuntimeRef.current,
      imagePasteWaiterRuntime: options.imagePasteWaiterRuntimeRef.current,
      updateSessionSync: options.updateSessionSync,
      recordRelayHostConnection: options.recordRelayHostConnection,
      handleAttachmentError: options.handleAttachmentError,
    });
  };

  const handleSocketConnectedBaseline = (connectedOptions: SessionSocketConnectedBaselineOptions) => {
    handleSocketConnectedBaselineRuntime({
      sessionId: connectedOptions.sessionId,
      sessionName: connectedOptions.sessionName,
      ws: connectedOptions.ws,
      refs: {
        stateRef: options.stateRef,
        tailRefreshStore: options.tailRefreshStore,
        lastConnectedBaselineAtRef: options.lastConnectedBaselineAtRef,
        connectedBaselineBurstGuardRef: options.connectedBaselineBurstGuardRef,
      },
      readSessionBufferSnapshot: options.readSessionBufferSnapshot,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      updateSessionSync: options.updateSessionSync,
      setScheduleStateForSession: options.setScheduleStateForSession,
      sendSocketPayload: options.sendSocketPayload,
      isSessionTransportActive: options.isSessionTransportActive,
      requestSessionBufferHead,
      incrementConnectedSync: options.incrementConnectedSync,
    });
  };

  const finalizeSocketFailureBaseline = (baselineOptions: SessionSocketFailureBaselineOptions) => {
    return finalizeSocketFailureBaselineRuntime({
      sessionId: baselineOptions.sessionId,
      message: baselineOptions.message,
      markCompleted: baselineOptions.markCompleted,
      refs: {
        pendingSessionTransportOpenIntentsRef: options.pendingSessionTransportOpenIntentsRef,
        reconnectStore: options.reconnectStore,
      },
      cleanupSocket: options.cleanupSocket,
      writeSessionTransportToken: options.writeSessionTransportToken,
      updateSessionSync: options.updateSessionSync,
      setScheduleStateForSession: options.setScheduleStateForSession,
    });
  };

  return {
    requestSessionBufferSync,
    requestSessionBufferHead,
    handleSocketServerMessage,
    handleSocketConnectedBaseline,
    finalizeSocketFailureBaseline,
  };
}
