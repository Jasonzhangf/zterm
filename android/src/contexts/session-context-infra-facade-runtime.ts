import { flushRuntimeDebugLogsToSessionTransport } from '../lib/runtime-debug-flush';
import type { BridgeSettings } from '../lib/bridge-settings';
import {
  getSessionTargetTerminalTransport,
  getSessionTerminalChannel,
  setSessionChannelBodySubscribed,
  type SessionTransportRuntimeStore,
} from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { Host, Session, SessionBufferState, SessionRenderBufferSnapshot, SessionScheduleState, TerminalBufferPayload } from '../lib/types';
import type { RecordSessionTxOptions } from './session-context-pull-runtime';
import type { RevisionResetExpectation, SessionAction, SessionManagerState, SessionReconnectRuntime } from './session-context-core';
import type { SessionBufferHeadState } from './session-buffer-planner-helpers';
import type { SessionPullPurpose } from './session-pull-state-helpers';
import {
  buildTerminalMuxChannelBinary,
  buildTerminalMuxChannelMessage,
  buildTerminalMuxTargetMessage,
  classifyTerminalMuxClientMessage,
  type BridgeClientMessage,
  type TerminalMuxClientFrame,
} from '@zterm/shared/protocol';
import {
  applySessionActionRuntime,
  applyTransportDiagnosticsRuntime,
  buildTraversalSocketForHostRuntime,
  clearHeartbeatRuntime,
  clearSessionHandshakeTimeoutInfraRuntime,
  clearSessionPullStateInfraRuntime,
  clearTailRefreshRuntimeInfra,
  createSessionSyncRuntime,
  createTransportInfraAccessorsRuntime,
  deleteSessionSyncRuntime,
  getSessionRenderBufferStoreRuntime,
  getSessionRenderBufferSnapshotRuntime,
  hasPendingSessionTransportOpenRuntime,
  incrementConnectedSyncRuntime,
  isPendingSessionTransportOpenStaleRuntime,
  isReconnectInFlightRuntime,
  isSessionTransportActiveRuntime,
  shouldAcceptSessionLiveBufferRuntime,
  isSessionTransportActivityStaleInfraRuntime,
  markPendingInputTailRefreshInfraRuntime,
  moveSessionSyncRuntime,
  readSessionBufferSnapshotRuntime,
  readSessionTransportTokenRuntime,
  recordSessionRxInfraRuntime,
  recordSessionRxBytesOnlyInfraRuntime,
  recordSessionTxInfraRuntime,
  resetSessionTransportPullBookkeepingInfraRuntime,
  resolvePhysicalBodySubscribedSessionIdsRuntime,
  resolveSessionCacheLinesRuntime,
  sendSocketPayloadInfraRuntime,
  setActiveSessionSyncRuntime,
  setLiveSessionsSyncRuntime,
  setScheduleStateForSessionRuntime,
  setSessionHandshakeTimeoutInfraRuntime,
  setSessionTitleSyncRuntime,
  settleSessionPullStateInfraRuntime,
  startSocketHeartbeatInfraRuntime,
  updateSessionSyncRuntime,
  writeSessionTransportTokenRuntime,
} from './session-context-infra-runtime';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function encodeArrayBufferToBase64(data: ArrayBuffer) {
  const bytes = new Uint8Array(data);
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    const chunk = bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  const bufferCtor = (globalThis as unknown as {
    Buffer?: { from(input: string, encoding: 'binary'): { toString(encoding: 'base64'): string } };
  }).Buffer;
  if (bufferCtor) {
    return bufferCtor.from(binary, 'binary').toString('base64');
  }
  throw new Error('terminal mux binary encoding unavailable');
}

function requireTerminalMuxChannel(
  store: SessionTransportRuntimeStore,
  sessionId: string,
) {
  const channel = getSessionTerminalChannel(store, sessionId);
  if (!channel || (channel.state !== 'opening' && channel.state !== 'open')) {
    throw new Error(`terminal mux channel is not open for session ${sessionId}`);
  }
  return channel;
}

export function wrapSessionPayloadForTargetMuxRuntime(options: {
  store: SessionTransportRuntimeStore;
  sessionId: string;
  ws: BridgeTransportSocket;
  data: string | ArrayBuffer;
  now?: number;
}): string | ArrayBuffer {
  const targetSocket = getSessionTargetTerminalTransport(options.store, options.sessionId);
  if (!targetSocket || targetSocket !== options.ws) {
    return options.data;
  }
  if (typeof options.data !== 'string') {
    const channel = requireTerminalMuxChannel(options.store, options.sessionId);
    return JSON.stringify(buildTerminalMuxChannelBinary(
      channel.channelId,
      encodeArrayBufferToBase64(options.data),
    ));
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(options.data);
  } catch {
    const channel = requireTerminalMuxChannel(options.store, options.sessionId);
    return JSON.stringify(buildTerminalMuxChannelMessage(channel.channelId, {
      type: 'input',
      payload: options.data,
    }));
  }

  if (!isRecord(parsed) || typeof parsed.type !== 'string') {
    throw new Error('terminal mux outbound payload requires a typed JSON message');
  }
  if (parsed.type.startsWith('mux-')) {
    return options.data;
  }
  if (parsed.type === 'ping') {
    const frame: TerminalMuxClientFrame = {
      type: 'mux-ping',
      payload: {
        sentAt: Number.isFinite(options.now) ? Math.max(0, Math.floor(options.now || 0)) : Date.now(),
      },
    };
    return JSON.stringify(frame);
  }
  if (parsed.type === 'close') {
    const channel = requireTerminalMuxChannel(options.store, options.sessionId);
    const frame: TerminalMuxClientFrame = {
      type: 'mux-channel-close',
      payload: {
        channelId: channel.channelId,
        reason: 'client requested channel close',
      },
    };
    return JSON.stringify(frame);
  }

  const message = parsed as BridgeClientMessage;
  const lane = classifyTerminalMuxClientMessage(message);
  if (lane === 'legacy') {
    throw new Error(`legacy terminal message ${message.type} cannot be sent on mux target transport`);
  }
  if (lane === 'target') {
    return JSON.stringify(buildTerminalMuxTargetMessage(message as Parameters<typeof buildTerminalMuxTargetMessage>[0]));
  }
  const channel = requireTerminalMuxChannel(options.store, options.sessionId);
  return JSON.stringify(buildTerminalMuxChannelMessage(
    channel.channelId,
    message as Parameters<typeof buildTerminalMuxChannelMessage>[1],
  ));
}

export function createSessionInfraFacadeRuntime(options: {
  stateRef: { current: SessionManagerState };
  dispatch: React.Dispatch<SessionAction>;
  reduceSessionAction: (state: SessionManagerState, action: SessionAction) => SessionManagerState;
  transportRuntimeStoreRef: { current: any };
  sessionBufferStoreRef: { current: any };
  sessionRenderGateRef: { current: any };
  sessionHeadStoreRef: { current: any };
  sessionDebugMetricsStoreRef: { current: any };
  scheduleStatesRef: { current: Record<string, SessionScheduleState> };
  setScheduleStates: React.Dispatch<React.SetStateAction<Record<string, SessionScheduleState>>>;
  sessionAttachTokensRef: { current: Map<string, string> };
  pendingSessionTransportOpenIntentsRef: { current: Map<string, unknown> };
  activeBodySubscriptionSuppressedRef: { current: boolean };
  reconnectRuntimesRef: { current: Map<string, SessionReconnectRuntime> };
  pendingInputTailRefreshRef: { current: Map<string, { requestedAt: number; localRevision: number }> };
  pendingConnectTailRefreshRef: { current: Set<string> };
  pendingResumeTailRefreshRef: { current: Set<string> };
  sessionPullStateRef: { current: Map<string, unknown> };
  lastServerActivityAtRef: { current: Map<string, number> };
  lastTerminalActivityAtRef: { current: Map<string, number> };
  staleTransportProbeAtRef: { current: Map<string, number> };
  lastPongAtRef: { current: Map<string, number> };
  pingIntervalsRef: { current: Map<string, ReturnType<typeof setInterval>> };
  handshakeTimeoutsRef: { current: Map<string, number> };
  sessionBufferHeadsRef: { current: Map<string, SessionBufferHeadState> };
  sessionRevisionResetRef: { current: Map<string, RevisionResetExpectation> };
  lastHeadRequestAtRef: { current: Map<string, number> };
  lastSyncRequestAtRef: { current: Map<string, unknown> };
  terminalCacheLines: number;
  defaultRows: number;
  bridgeSettings: BridgeSettings;
  wsUrl?: string;
  staleActivityMs: number;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const applySessionAction = (action: SessionAction) => {
    applySessionActionRuntime({
      stateRef: options.stateRef,
      action,
      reduceSessionAction: options.reduceSessionAction,
      dispatch: options.dispatch,
    });
  };

  const readSessionBufferSnapshot = (sessionId: string): SessionBufferState => {
    return readSessionBufferSnapshotRuntime({
      sessionId,
      sessionBufferStoreRef: options.sessionBufferStoreRef,
    });
  };

  const updateSessionSync = (id: string, updates: Partial<Session>) => {
    updateSessionSyncRuntime({
      id,
      updates,
      applySessionAction,
    });
  };

  const setActiveSessionSync = (id: string) => {
    setActiveSessionSyncRuntime({
      id,
      applySessionAction,
    });
    reconcilePhysicalBodySubscriptions('active-session');
  };

  const setLiveSessionIdsSync = (ids: string[]) => {
    setLiveSessionsSyncRuntime({
      ids,
      applySessionAction,
    });
    reconcilePhysicalBodySubscriptions('live-sessions');
  };

  const setActiveBodySubscriptionSuppressedSync = (suppressed: boolean, reason = 'active-body-subscription-suppressed') => {
    if (options.activeBodySubscriptionSuppressedRef.current === suppressed) {
      return;
    }
    options.activeBodySubscriptionSuppressedRef.current = suppressed;
    reconcilePhysicalBodySubscriptions(reason);
  };

  const createSessionSync = (session: Session) => {
    createSessionSyncRuntime({
      session,
      applySessionAction,
    });
  };

  const deleteSessionSync = (id: string) => {
    deleteSessionSyncRuntime({
      id,
      manualClose: true,
      applySessionAction,
    });
  };

  const moveSessionSync = (id: string, toIndex: number) => {
    moveSessionSyncRuntime({
      id,
      toIndex,
      applySessionAction,
    });
  };

  const setSessionTitleSync = (id: string, title: string) => {
    setSessionTitleSyncRuntime({
      id,
      title,
      applySessionAction,
    });
  };

  const incrementConnectedSync = () => {
    incrementConnectedSyncRuntime({
      applySessionAction,
    });
  };

  const transportAccessors = createTransportInfraAccessorsRuntime(options.transportRuntimeStoreRef);

  function reconcilePhysicalBodySubscriptions(reason: string) {
    const liveSessionIds = resolvePhysicalBodySubscribedSessionIdsRuntime({
      activeSessionId: options.stateRef.current.activeSessionId,
      liveSessionIds: options.stateRef.current.liveSessionIds,
      activeBodySubscriptionSuppressed: options.activeBodySubscriptionSuppressedRef.current,
    });
    for (const session of options.stateRef.current.sessions) {
      const channel = transportAccessors.readSessionTerminalChannel(session.id);
      const subscribed = liveSessionIds.has(session.id);
      setSessionChannelBodySubscribed(options.transportRuntimeStoreRef.current, session.id, subscribed);
      const ws = channel
        ? (
          channel.state === 'open'
            ? transportAccessors.readSessionTransportResource(session.id).socket
            : null
        )
        : transportAccessors.readSessionTransportSocket(session.id);
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        continue;
      }
      sendSocketPayload(session.id, ws, JSON.stringify({
        type: 'body-subscription',
        payload: {
          version: 1,
          subscribed,
        },
      }));
      options.runtimeDebug('session.body-subscription.sent', {
        sessionId: session.id,
        subscribed,
        reason,
      });
    }
  }

  const readSessionTransportToken = (sessionId: string) => {
    return readSessionTransportTokenRuntime({
      sessionId,
      sessionAttachTokensRef: options.sessionAttachTokensRef,
    });
  };

  const writeSessionTransportToken = (sessionId: string, token: string | null) => {
    return writeSessionTransportTokenRuntime({
      sessionId,
      token,
      sessionAttachTokensRef: options.sessionAttachTokensRef,
    });
  };

  const isSessionTransportActive = (sessionId: string) => {
    return isSessionTransportActiveRuntime({
      sessionId,
      stateRef: options.stateRef,
    });
  };


  const shouldAcceptSessionLiveBuffer = (sessionId: string) => {
    return shouldAcceptSessionLiveBufferRuntime({
      sessionId,
      stateRef: options.stateRef,
      readSessionBufferSnapshot,
    });
  };

  const hasPendingSessionTransportOpen = (sessionId: string) => {
    return hasPendingSessionTransportOpenRuntime({
      sessionId,
      pendingSessionTransportOpenIntentsRef: options.pendingSessionTransportOpenIntentsRef,
    });
  };

  const isPendingSessionTransportOpenStale = (sessionId: string, staleAfterMs?: number) => {
    return isPendingSessionTransportOpenStaleRuntime({
      sessionId,
      pendingSessionTransportOpenIntentsRef: options.pendingSessionTransportOpenIntentsRef,
      staleAfterMs,
    });
  };

  const isReconnectInFlight = (sessionId: string) => {
    return isReconnectInFlightRuntime({
      sessionId,
      reconnectRuntimesRef: options.reconnectRuntimesRef,
    });
  };

  const resolveSessionCacheLines = (rows?: number | null) => {
    return resolveSessionCacheLinesRuntime({
      rows,
      terminalCacheLines: options.terminalCacheLines,
      defaultRows: options.defaultRows,
    });
  };

  const getSessionRenderBufferSnapshot = (sessionId: string): SessionRenderBufferSnapshot => {
    return getSessionRenderBufferSnapshotRuntime({
      sessionId,
      sessionRenderStoreRef: {
        current: getSessionRenderBufferStoreRuntime({
          sessionRenderGateRef: options.sessionRenderGateRef,
        }),
      },
    });
  };

  const getSessionBufferStore = () => options.sessionBufferStoreRef.current;
  const getSessionRenderBufferStore = () => getSessionRenderBufferStoreRuntime({
    sessionRenderGateRef: options.sessionRenderGateRef,
  });
  const getSessionHeadStore = () => options.sessionHeadStoreRef.current;

  const scheduleSessionRenderCommit = (sessionId: string) => {
    options.sessionRenderGateRef.current.scheduleCommit(sessionId);
  };

  const recordSessionTx = (sessionId: string, data: string | ArrayBuffer, recordOptions?: RecordSessionTxOptions) => {
    recordSessionTxInfraRuntime({
      sessionId,
      data,
      refs: {
        sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
        sessionPullStateRef: options.sessionPullStateRef,
      },
      recordOptions,
    });
  };

  const recordSessionRx = (sessionId: string, data: string | ArrayBuffer) => {
    recordSessionRxInfraRuntime({
      sessionId,
      data,
      refs: {
        sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
        lastServerActivityAtRef: options.lastServerActivityAtRef,
        lastTerminalActivityAtRef: options.lastTerminalActivityAtRef,
        staleTransportProbeAtRef: options.staleTransportProbeAtRef,
      },
    });
  };

  const recordSessionRxBytesOnly = (sessionId: string, data: string | ArrayBuffer) => {
    recordSessionRxBytesOnlyInfraRuntime({
      sessionId,
      data,
      refs: {
        sessionDebugMetricsStoreRef: options.sessionDebugMetricsStoreRef,
      },
    });
  };

  const markPendingInputTailRefresh = (sessionId: string, localRevision: number) => {
    return markPendingInputTailRefreshInfraRuntime({
      sessionId,
      localRevision,
      pendingInputTailRefreshRef: options.pendingInputTailRefreshRef,
    });
  };

  const clearSessionPullState = (sessionId: string, purpose?: SessionPullPurpose) => {
    clearSessionPullStateInfraRuntime({
      sessionId,
      sessionPullStateRef: options.sessionPullStateRef,
      purpose,
    });
  };

  const settleSessionPullState = (sessionId: string, payload: TerminalBufferPayload) => {
    settleSessionPullStateInfraRuntime({
      sessionId,
      payload,
      sessionPullStateRef: options.sessionPullStateRef,
    });
  };

  const resetSessionTransportPullBookkeeping = (sessionId: string, reason: string) => {
    resetSessionTransportPullBookkeepingInfraRuntime({
      sessionId,
      reason,
      activeSessionId: options.stateRef.current.activeSessionId,
      sessionPullStateRef: options.sessionPullStateRef,
      pendingInputTailRefreshRef: options.pendingInputTailRefreshRef,
      lastSyncRequestAtRef: options.lastSyncRequestAtRef,
      runtimeDebug: options.runtimeDebug,
    });
  };

  const isSessionTransportActivityStale = (sessionId: string) => {
    return isSessionTransportActivityStaleInfraRuntime({
      sessionId,
      lastServerActivityAtRef: options.lastServerActivityAtRef,
      staleActivityMs: options.staleActivityMs,
    });
  };

  const sendSocketPayload = (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer, recordOptions?: RecordSessionTxOptions) => {
    const outboundData = wrapSessionPayloadForTargetMuxRuntime({
      store: options.transportRuntimeStoreRef.current,
      sessionId,
      ws,
      data,
    });
    sendSocketPayloadInfraRuntime({
      sessionId,
      ws,
      data: outboundData,
      recordSessionTx,
      recordOptions,
    });
  };

  const buildTraversalSocketForHost = (host: Host, transportRole: 'control' | 'session' = 'session') => {
    return buildTraversalSocketForHostRuntime({
      host,
      bridgeSettings: options.bridgeSettings,
      wsUrl: options.wsUrl,
      transportRole,
    });
  };

  const applyTransportDiagnostics = (sessionId: string, socket: BridgeTransportSocket) => {
    applyTransportDiagnosticsRuntime({
      sessionId,
      socket,
      updateSessionSync,
      runtimeDebug: options.runtimeDebug,
    });
  };

  const flushRuntimeDebugLogs = () => {
    flushRuntimeDebugLogsToSessionTransport({
      activeSessionId: options.stateRef.current.activeSessionId,
      readSessionTransportSocket: transportAccessors.readSessionTransportSocket,
      sendSocketPayload,
    });
  };

  const setScheduleStateForSession = (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => {
    setScheduleStateForSessionRuntime({
      sessionId,
      nextState,
      setScheduleStates: options.setScheduleStates,
      stateRef: options.stateRef,
    });
  };

  const clearHeartbeat = (sessionId: string) => {
    clearHeartbeatRuntime({
      sessionId,
      pingIntervalsRef: options.pingIntervalsRef,
      lastPongAtRef: options.lastPongAtRef,
      lastServerActivityAtRef: options.lastServerActivityAtRef,
    });
  };

  const clearSessionHandshakeTimeout = (sessionId: string) => {
    clearSessionHandshakeTimeoutInfraRuntime({
      sessionId,
      handshakeTimeoutsRef: options.handshakeTimeoutsRef,
    });
  };

  const setSessionHandshakeTimeout = (sessionId: string, callback: () => void, delayMs: number) => {
    return setSessionHandshakeTimeoutInfraRuntime({
      sessionId,
      callback,
      delayMs,
      handshakeTimeoutsRef: options.handshakeTimeoutsRef,
    });
  };

  const clearTailRefreshRuntime = (sessionId: string) => {
    clearTailRefreshRuntimeInfra({
      sessionId,
      sessionBufferHeadsRef: options.sessionBufferHeadsRef,
      sessionRevisionResetRef: options.sessionRevisionResetRef,
      lastHeadRequestAtRef: options.lastHeadRequestAtRef,
      pendingInputTailRefreshRef: options.pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef: options.pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef: options.pendingResumeTailRefreshRef,
    });
  };

  const startSocketHeartbeat = (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
  ) => {
    startSocketHeartbeatInfraRuntime({
      sessionId,
      ws,
      finalizeFailure,
      pingIntervalsRef: options.pingIntervalsRef,
      lastPongAtRef: options.lastPongAtRef,
      lastServerActivityAtRef: options.lastServerActivityAtRef,
      clientPingIntervalMs: 2000,
      maxConsecutiveMisses: 3,
      sendSocketPayload,
    });
  };

  return {
    applySessionAction,
    readSessionBufferSnapshot,
    updateSessionSync,
    setActiveSessionSync,
    setLiveSessionIdsSync,
    setActiveBodySubscriptionSuppressedSync,
    createSessionSync,
    deleteSessionSync,
    moveSessionSync,
    setSessionTitleSync,
    incrementConnectedSync,
    ...transportAccessors,
    readSessionTransportToken,
    writeSessionTransportToken,
    isSessionTransportActive,
    shouldAcceptSessionLiveBuffer,
    hasPendingSessionTransportOpen,
    isPendingSessionTransportOpenStale,
    isReconnectInFlight,
    resolveSessionCacheLines,
    getSessionRenderBufferSnapshot,
    getSessionBufferStore,
    getSessionRenderBufferStore,
    getSessionHeadStore,
    scheduleSessionRenderCommit,
    recordSessionTx,
    recordSessionRx,
    recordSessionRxBytesOnly,
    markPendingInputTailRefresh,
    clearSessionPullState,
    settleSessionPullState,
    resetSessionTransportPullBookkeeping,
    isSessionTransportActivityStale,
    sendSocketPayload,
    buildTraversalSocketForHost,
    applyTransportDiagnostics,
    flushRuntimeDebugLogs,
    setScheduleStateForSession,
    clearHeartbeat,
    clearSessionHandshakeTimeout,
    setSessionHandshakeTimeout,
    clearTailRefreshRuntime,
    startSocketHeartbeat,
  };
}
