import { runtimeDebug } from '../lib/runtime-debug';
import type { MutableRefObject } from 'react';
import type { TerminalBufferPayload } from '../lib/types';
import {
  applyIncomingBufferSyncRuntime,
  handleBufferHeadRuntime,
  requestSessionBufferHeadRuntime,
  requestSessionBufferSyncRuntime,
} from './session-context-buffer-runtime';
import {
  finalizeSocketFailureBaselineRuntime,
  handleSocketConnectedBaselineRuntime,
  handleSocketServerMessageRuntime,
} from './session-context-socket-message-runtime';

export function summarizeBufferPayload(payload: TerminalBufferPayload) {
  const firstLine = payload.lines[0];
  const lastLine = payload.lines[payload.lines.length - 1];
  return {
    revision: payload.revision,
    startIndex: payload.startIndex,
    endIndex: payload.endIndex,
    generatedAt: payload.generatedAt ?? null,
    requestSentAt: payload.requestSentAt ?? null,
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
  stateRef: MutableRefObject<any>;
  scheduleStatesRef: MutableRefObject<any>;
  sessionVisibleRangeRef: MutableRefObject<any>;
  sessionBufferHeadsRef: MutableRefObject<any>;
  sessionPullStateRef: MutableRefObject<any>;
  sessionRevisionResetRef: MutableRefObject<any>;
  sessionBufferStoreRef: MutableRefObject<any>;
  sessionHeadStoreRef: MutableRefObject<any>;
  sessionDebugMetricsStoreRef: MutableRefObject<any>;
  lastSyncRequestAtRef: MutableRefObject<any>;
  lastHeadRequestAtRef: MutableRefObject<any>;
  staleTransportProbeAtRef: MutableRefObject<any>;
  lastPongAtRef: MutableRefObject<any>;
  lastConnectedBaselineAtRef: MutableRefObject<any>;
  connectedBaselineBurstGuardRef: MutableRefObject<any>;
  pendingInputTailRefreshRef: MutableRefObject<any>;
  pendingConnectTailRefreshRef: MutableRefObject<any>;
  pendingResumeTailRefreshRef: MutableRefObject<any>;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<any>;
  manualCloseRef: MutableRefObject<any>;
  fileTransferMessageRuntimeRef: MutableRefObject<any>;
  remoteWindowMessageRuntimeRef: MutableRefObject<any>;
  readSessionTransportSocket: (sessionId: string) => any;
  readSessionTransportResource?: (sessionId: string) => any;
  readSessionBufferSnapshot: (sessionId: string) => any;
  sendSocketPayload: (sessionId: string, ws: any, data: string | ArrayBuffer) => void;
  clearSessionPullState: (sessionId: string) => void;
  settleSessionPullState: (...args: any[]) => void;
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
  setScheduleStateForSession: (sessionId: string, nextState: any) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  updateSessionSync: (id: string, updates: any) => void;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  applyTransportDiagnostics: (...args: any[]) => void;
  incrementConnectedSync: () => void;
}

export interface SessionMessageAssembliesResult {
  requestSessionBufferSync: (sessionId: string, requestOptions?: any) => boolean;
  requestSessionBufferHead: (
    sessionId: string,
    ws?: any,
    headOptions?: { force?: boolean; trackProbe?: boolean },
  ) => boolean;
  handleSocketServerMessage: (messageOptions: any, msg: any) => void;
  handleSocketConnectedBaseline: (connectedOptions: any) => void;
  finalizeSocketFailureBaseline: (baselineOptions: any) => any;
}

export function createSessionMessageAssemblies(
  options: SessionMessageAssembliesOptions,
): SessionMessageAssembliesResult {
  const commitSessionBufferUpdate = (sessionId: string, nextBuffer: any) => {
    return options.sessionBufferStoreRef.current.commitBuffer(sessionId, nextBuffer);
  };

  const requestSessionBufferSync = (sessionId: string, requestOptions?: {
    ws?: any;
    reason?: string;
    purpose?: any;
    sessionOverride?: any;
    liveHead?: any;
    invalidLocalWindow?: boolean;
    requestWindowOverride?: { requestStartIndex: number; requestEndIndex: number } | null;
    requestMissingRangesOverride?: Array<{ startIndex: number; endIndex: number }> | null;
  }) => requestSessionBufferSyncRuntime({
    sessionId,
    requestOptions,
    refs: {
      stateRef: options.stateRef,
      sessionVisibleRangeRef: options.sessionVisibleRangeRef,
      sessionBufferHeadsRef: options.sessionBufferHeadsRef,
      sessionPullStateRef: options.sessionPullStateRef,
      lastSyncRequestAtRef: options.lastSyncRequestAtRef,
      pendingInputTailRefreshRef: options.pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef: options.pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef: options.pendingResumeTailRefreshRef,
    },
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
    ws?: any,
    headOptions?: { force?: boolean; trackProbe?: boolean },
  ) => requestSessionBufferHeadRuntime({
    sessionId,
    ws,
    force: headOptions?.force,
    trackProbe: headOptions?.trackProbe,
    refs: {
      stateRef: options.stateRef,
      lastHeadRequestAtRef: options.lastHeadRequestAtRef,
      staleTransportProbeAtRef: options.staleTransportProbeAtRef,
      sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
    },
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
    cursor?: any,
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
        sessionBufferHeadsRef: options.sessionBufferHeadsRef,
        lastHeadRequestAtRef: options.lastHeadRequestAtRef,
        lastSyncRequestAtRef: options.lastSyncRequestAtRef,
        sessionRevisionResetRef: options.sessionRevisionResetRef,
        sessionVisibleRangeRef: options.sessionVisibleRangeRef,
        sessionBufferStoreRef: options.sessionBufferStoreRef,
        sessionHeadStoreRef: options.sessionHeadStoreRef,
      },
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
        sessionBufferHeadsRef: options.sessionBufferHeadsRef,
        pendingInputTailRefreshRef: options.pendingInputTailRefreshRef,
        pendingConnectTailRefreshRef: options.pendingConnectTailRefreshRef,
        pendingResumeTailRefreshRef: options.pendingResumeTailRefreshRef,
        lastSyncRequestAtRef: options.lastSyncRequestAtRef,
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

  const handleSocketServerMessage = (messageOptions: {
    sessionId: string;
    host: any;
    ws: any;
    debugScope: 'connect' | 'reconnect';
    rawFrameBytes?: number;
    onConnected: () => void;
    onFailure: (message: string, retryable: boolean) => void;
    onClosed: (reason?: string) => void;
  }, msg: any) => {
    handleSocketServerMessageRuntime({
      params: messageOptions,
      msg,
      refs: {
        stateRef: options.stateRef,
        scheduleStatesRef: options.scheduleStatesRef,
        lastHeadRequestAtRef: options.lastHeadRequestAtRef,
        lastPongAtRef: options.lastPongAtRef,
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
      updateSessionSync: options.updateSessionSync,
    });
  };

  const handleSocketConnectedBaseline = (connectedOptions: {
    sessionId: string;
    sessionName: string;
    ws: any;
  }) => {
    handleSocketConnectedBaselineRuntime({
      sessionId: connectedOptions.sessionId,
      sessionName: connectedOptions.sessionName,
      ws: connectedOptions.ws,
      refs: {
        stateRef: options.stateRef,
        pendingConnectTailRefreshRef: options.pendingConnectTailRefreshRef,
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

  const finalizeSocketFailureBaseline = (baselineOptions: {
    sessionId: string;
    message: string;
    markCompleted: () => boolean;
  }) => {
    return finalizeSocketFailureBaselineRuntime({
      sessionId: baselineOptions.sessionId,
      message: baselineOptions.message,
      markCompleted: baselineOptions.markCompleted,
      refs: {
        pendingSessionTransportOpenIntentsRef: options.pendingSessionTransportOpenIntentsRef,
        manualCloseRef: options.manualCloseRef,
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
