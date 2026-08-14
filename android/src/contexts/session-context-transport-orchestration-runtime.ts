import type { Host, ServerMessage, Session, SessionBufferState, SessionScheduleState, TerminalWidthMode } from '../lib/types';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type { SessionHeartbeatStore } from '../lib/session-heartbeat-store';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionTransportResource } from '../lib/session-transport-runtime';
import { createClientDaemonConnection } from '../lib/client-daemon-connection';
import { getResolvedSessionName } from '../lib/connection-target';
import type {
  QueueSessionTransportOpenIntentOptions,
} from './session-context-core';
import type {
  PendingSessionTransportOpenIntent,
} from './session-transport-open-helpers';
import {
  buildTargetTransportHeartbeatKey,
} from './session-context-socket-runtime';
import {
  buildSessionReconnectingFailureUpdates,
  buildSessionClosedUpdates,
  buildSessionIdleAfterReconnectBlockedUpdates,
} from './session-transport-open-helpers';
import {
  cleanupControlSocketOrchestrationRuntime,
  bindSessionTransportSocketLifecycleOrchestrationRuntime,
  primeSessionTransportSocketRuntime,
  sendTerminalResizeRuntime,
} from './session-context-transport-lifecycle-runtime';
import {
  bindTargetMuxTransportSocketLifecycleRuntime,
  handleTargetMuxServerFrameRuntime,
} from './session-context-transport-runtime';
import {
  buildTerminalMuxPing,
  type TerminalMuxTargetServerMessage,
} from '@zterm/shared/protocol';
import type {
  SessionTargetNetworkProbeFailure,
  SessionTargetNetworkProbeRuntime,
  SessionTargetNetworkProbeResult,
  SessionTargetNetworkSignal,
} from './session-context-target-network-probe-runtime';
import {
  applyTransportOpenConnectedEffectsRuntime,
  applyTransportOpenLiveFailureEffectsRuntime,
  buildConnectTransportOpenIntentOptionsRuntime,
  buildReconnectTransportOpenIntentOptionsRuntime,
  cleanupSocketRuntime,
  clearReconnectForSessionRuntime,
  clearSupersededSocketsRuntime,
  handleReconnectBeforeConnectSendRuntime,
  handleReconnectHandshakeFailureRuntime,
  openSessionMuxChannelByIntentRuntime,
  queueSessionTransportOpenIntentRuntime,
  queueTransportOpenIntentRuntime,
} from './session-context-transport-open-runtime';
import {
  computeReconnectDelay,
} from './session-context-core';
import {
  hasSessionLocalWindow,
} from './session-buffer-planner-helpers';
import {
  shouldAutoReconnectSession,
} from '../lib/session-reconnect-helpers';
import {
  scheduleReconnectRuntime,
  startReconnectAttemptRuntime,
} from './session-context-session-runtime';
import {
  deletePendingSessionTransportOpenIntent,
  getPendingSessionTransportOpenIntent,
} from './session-context-open-intent-store';
import {
  manageTmuxSessionsOnOpenTransportRuntime,
  type SessionTmuxTargetRequestStore,
} from './session-context-tmux-management-runtime';

interface MutableRefObject<T> {
  current: T;
}

export function resolveMuxChannelClosedWithControlStatusRuntime(options: {
  sessionId: string;
  sessionName: string;
  channelId: string;
  reason: string;
  shouldReconnectNow: boolean;
  queryTargetSessions: () => Promise<string[] | null>;
  routeTargetControlUnavailable?: (sessionId: string, message: string) => void;
  readSessionTerminalChannel: (sessionId: string) => {
    channelId: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
  } | null;
  scheduleReconnect: (sessionId: string, message: string, retryable?: boolean) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  emitSessionStatus: (sessionId: string, type: 'closed' | 'error', message?: string) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const readCurrentClosedChannel = () => {
    const channel = options.readSessionTerminalChannel(options.sessionId);
    if (!channel || channel.channelId !== options.channelId || channel.state !== 'closed') {
      options.runtimeDebug('session.mux.channel-closed.control-status.stale', {
        sessionId: options.sessionId,
        channelId: options.channelId,
      });
      return null;
    }
    return channel;
  };

  if (!options.shouldReconnectNow) {
    options.updateSessionSync(
      options.sessionId,
      buildSessionIdleAfterReconnectBlockedUpdates(options.reason),
    );
  }

  void options.queryTargetSessions()
    .then((sessionNames) => {
      if (!readCurrentClosedChannel()) {
        return;
      }

      if (sessionNames === null) {
        if (options.shouldReconnectNow) {
          options.scheduleReconnect(options.sessionId, options.reason, true);
        }
        options.runtimeDebug('session.mux.channel-closed.control-status.unavailable', {
          sessionId: options.sessionId,
          sessionName: options.sessionName,
          reconnectNow: options.shouldReconnectNow,
        });
        return;
      }

      if (sessionNames && !sessionNames.includes(options.sessionName)) {
        options.updateSessionSync(options.sessionId, buildSessionClosedUpdates(options.reason));
        options.emitSessionStatus(options.sessionId, 'closed', options.reason);
        options.runtimeDebug('session.mux.channel-closed.control-status.session-missing', {
          sessionId: options.sessionId,
          sessionName: options.sessionName,
        });
        return;
      }

      if (options.shouldReconnectNow) {
        options.scheduleReconnect(options.sessionId, options.reason, true);
      }
      options.runtimeDebug('session.mux.channel-closed.control-status.session-present', {
        sessionId: options.sessionId,
        sessionName: options.sessionName,
        controlStatus: 'session-present',
        reconnectNow: options.shouldReconnectNow,
      });
    })
    .catch((error) => {
      if (!readCurrentClosedChannel()) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      options.runtimeDebug('session.mux.channel-closed.control-status.failed', {
        sessionId: options.sessionId,
        error: message,
      });
      if (options.shouldReconnectNow) {
        options.scheduleReconnect(options.sessionId, options.reason, true);
      }
    });
}

export function handleTargetMuxTransportFailureRuntime(options: {
  anchorSessionId: string;
  message: string;
  failedSocket: BridgeTransportSocket;
  readSessionTargetRuntime: (sessionId: string) => { key?: string; sessionIds: string[] } | null;
  readSessionTerminalChannel: (sessionId: string) => {
    state: 'opening' | 'open' | 'closing' | 'closed';
  } | null;
  writeSessionTerminalChannelState: (sessionId: string, state: 'opening' | 'open' | 'closing' | 'closed') => unknown;
  writeSessionTargetTerminalSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTargetTerminalMuxReady: (sessionId: string, ready: boolean) => unknown;
  clearHeartbeat?: (sessionId: string, heartbeatOptions?: { heartbeatKey?: string }) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  scheduleReconnect: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    reconnectOptions?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const targetRuntime = options.readSessionTargetRuntime(options.anchorSessionId);
  const targetSessionIds = targetRuntime?.sessionIds?.length
    ? targetRuntime.sessionIds
    : [options.anchorSessionId];

  options.failedSocket.reportFailure(options.message);
  options.writeSessionTargetTerminalMuxReady(options.anchorSessionId, false);
  options.writeSessionTargetTerminalSocket(options.anchorSessionId, null);
  const targetKey = typeof targetRuntime?.key === 'string' ? targetRuntime.key : '';
  if (targetKey && options.clearHeartbeat) {
    options.clearHeartbeat(options.anchorSessionId, {
      heartbeatKey: buildTargetTransportHeartbeatKey(targetKey),
    });
  }
  if (options.failedSocket.readyState < WebSocket.CLOSING) {
    options.failedSocket.close(4000, 'terminal mux target failed');
  }

  const replaySessionIds: string[] = [];
  for (const sessionId of targetSessionIds) {
    const channel = options.readSessionTerminalChannel(sessionId);
    const pending = getPendingSessionTransportOpenIntent(
      options.pendingSessionTransportOpenIntentsRef.current,
      sessionId,
    );
    if (!channel || channel.state === 'closed') {
      if (pending) {
        options.clearSessionHandshakeTimeout(sessionId);
        deletePendingSessionTransportOpenIntent(options.pendingSessionTransportOpenIntentsRef.current, sessionId);
      }
      continue;
    }

    options.writeSessionTerminalChannelState(sessionId, 'closed');
    if (pending) {
      options.clearSessionHandshakeTimeout(sessionId);
      deletePendingSessionTransportOpenIntent(options.pendingSessionTransportOpenIntentsRef.current, sessionId);
    }
    options.updateSessionSync(sessionId, buildSessionReconnectingFailureUpdates(options.message, 0));
    options.writeSessionTerminalChannelState(sessionId, 'opening');
    replaySessionIds.push(sessionId);
  }

  if (replaySessionIds.length > 0) {
    const replayAnchorSessionId = replaySessionIds.includes(options.anchorSessionId)
      ? options.anchorSessionId
      : replaySessionIds[0];
    // Reconnect the anchor with backoff, not an immediate reset loop.
    // `resetAttempt`/`immediate` used to zero the attempt counter and force a
    // 0ms delay on EVERY failure, which bypassed computeReconnectDelay and the
    // handshake attempt cap -> an unbounded tight reconnect loop (daemon saw
    // 3 sockets created/closed in a cycle). Keeping the attempt counter makes
    // the first failure reconnect right away (attempt 0 -> delay 0) and every
    // following failure back off exponentially.
    options.scheduleReconnect(replayAnchorSessionId, options.message, true, {
      immediate: false,
      resetAttempt: false,
      force: true,
    });
  }

  options.runtimeDebug('session.mux.target-transport-failed', {
    anchorSessionId: options.anchorSessionId,
    message: options.message,
    affectedSessionCount: replaySessionIds.length,
    replaySessionIds,
  });
}

export function routeTargetSocketFailureRuntime(options: {
  targetKey: string;
  failedSocket: BridgeTransportSocket;
  message: string;
  readTargetTransportRuntime: (targetKey: string) => NetworkProbeTargetRuntime | null;
  writeTargetTerminalSocket: (targetKey: string, socket: BridgeTransportSocket | null) => unknown;
  writeTargetTerminalMuxReady: (targetKey: string, ready: boolean) => unknown;
  clearHeartbeat: (sessionId: string, heartbeatOptions?: { heartbeatKey?: string }) => void;
  handleAnchoredFailure: (anchorSessionId: string) => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const targetRuntime = options.readTargetTransportRuntime(options.targetKey);
  if (!targetRuntime || targetRuntime.terminalTransport !== options.failedSocket) {
    options.runtimeDebug('session.mux.target-transport-failure.stale-generation', {
      targetKey: options.targetKey,
      message: options.message,
    });
    return 'stale' as const;
  }
  const anchorSessionId = targetRuntime.sessionIds.find((sessionId) => sessionId.trim()) || null;
  if (anchorSessionId) {
    options.handleAnchoredFailure(anchorSessionId);
    return 'anchored' as const;
  }

  options.failedSocket.reportFailure(options.message);
  options.writeTargetTerminalMuxReady(options.targetKey, false);
  options.writeTargetTerminalSocket(options.targetKey, null);
  options.clearHeartbeat(options.targetKey, {
    heartbeatKey: buildTargetTransportHeartbeatKey(options.targetKey),
  });
  if (options.failedSocket.readyState < WebSocket.CLOSING) {
    options.failedSocket.close(4000, 'terminal mux target failed');
  }
  options.runtimeDebug('session.mux.target-transport-failed', {
    targetKey: options.targetKey,
    message: options.message,
    affectedSessionCount: 0,
    replaySessionIds: [],
  });
  return 'idle-retired' as const;
}

interface NetworkProbeTargetRuntime {
  key: string;
  sessionIds: string[];
  terminalTransport: BridgeTransportSocket | null;
}

export interface TargetNetworkProbeOutcome {
  targetKey: string;
  result: SessionTargetNetworkProbeResult;
}

function projectTargetNetworkProbeFailureMessage(failure: SessionTargetNetworkProbeFailure): string {
  switch (failure.type) {
    case 'TargetNetworkProbeError01GenerationTimeout':
      return 'network generation target probe timeout';
    case 'TargetNetworkProbeError02SendFailure':
      return 'network generation target probe send failed';
    case 'TargetNetworkProbeError03TerminalSocketState':
      return `network generation target transport terminal state ${failure.readyState}`;
    default: {
      const unreachableFailure: never = failure;
      throw new Error(`unhandled target network probe failure: ${String(unreachableFailure)}`);
    }
  }
}

export function notifyTargetNetworkSignalRuntime(options: {
  signal: SessionTargetNetworkSignal;
  targetRuntimes: NetworkProbeTargetRuntime[];
  targetNetworkProbeRuntime: SessionTargetNetworkProbeRuntime;
  sendTargetProbe: (
    targetKey: string,
    socket: BridgeTransportSocket,
    sentAt: number,
  ) => void;
  submitTargetSocketFailure: (
    targetKey: string,
    socket: BridgeTransportSocket,
    message: string,
  ) => void;
  wakeScheduledReconnects?: () => void;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
}) {
  const outcomes: TargetNetworkProbeOutcome[] = [];
  const shouldWakeReconnects = options.signal.source === 'foreground-resume'
    || options.signal.connected === true;
  if (shouldWakeReconnects) {
    options.wakeScheduledReconnects?.();
  }

  // A client network-generation change invalidates every physical transport
  // assumption built on the previous local network (WiFi/cellular/VPN/IP set).
  // Retire each exact socket immediately through the single target failure
  // owner instead of waiting for a bounded probe that is only meaningful
  // within one generation. Same-generation signals keep the conservative
  // probe path below.
  if (options.signal.fingerprintChanged === true) {
    const message = `client network generation changed to ${options.signal.networkGeneration ?? 'unknown'}`;
    for (const targetRuntime of options.targetRuntimes) {
      const socket = targetRuntime.terminalTransport;
      if (!socket) {
        continue;
      }
      options.submitTargetSocketFailure(targetRuntime.key, socket, message);
      outcomes.push({ targetKey: targetRuntime.key, result: 'generation-changed' });
      options.runtimeDebug('session.mux.target-network-generation-changed', {
        targetKey: targetRuntime.key,
        source: options.signal.source,
        networkGeneration: options.signal.networkGeneration,
      });
    }
    return outcomes;
  }

  for (const targetRuntime of options.targetRuntimes) {
    const socket = targetRuntime.terminalTransport;
    if (!socket) {
      continue;
    }
    const result = options.targetNetworkProbeRuntime.probe({
      targetKey: targetRuntime.key,
      socket,
      sendProbe: (probeSocket, sentAt) => {
        options.sendTargetProbe(targetRuntime.key, probeSocket, sentAt);
      },
      onFailure: (failure) => {
        if (failure.type === 'TargetNetworkProbeError01GenerationTimeout') {
          options.runtimeDebug('session.mux.target-network-probe.inconclusive', {
            targetKey: failure.targetKey,
            source: options.signal.source,
            readyState: failure.socket.readyState,
          });
          return;
        }
        options.submitTargetSocketFailure(
          failure.targetKey,
          failure.socket,
          projectTargetNetworkProbeFailureMessage(failure),
        );
      },
    });
    const outcome: TargetNetworkProbeOutcome = {
      targetKey: targetRuntime.key,
      result,
    };
    outcomes.push(outcome);
    const signalMetadata = options.signal.source === 'foreground-resume'
      ? { source: options.signal.source }
      : {
        source: options.signal.source,
        connected: options.signal.connected,
        connectionType: options.signal.connectionType,
      };
    options.runtimeDebug('session.target-network-probe.signal', {
      ...outcome,
      ...signalMetadata,
    });
  }
  return outcomes;
}

export function createSessionTransportOrchestrationRuntime(options: {
  stateRef: MutableRefObject<{ sessions: Session[]; activeSessionId: string | null; liveSessionIds?: string[] }>;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  runtimeDebug: (event: string, payload?: Record<string, unknown>) => void;
  sessionHandshakeTimeoutMs: number;
  sessionTerminalReadyTimeoutMs?: number;
  /** Relay-assigned device id of this client (from bridge settings). */
  clientDeviceId?: string;
  refs: {
    pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
    reconnectStore: SessionReconnectStore;
    heartbeatStore: SessionHeartbeatStore;
    targetNetworkProbeRuntime: SessionTargetNetworkProbeRuntime;
    tmuxTargetRequestsRef: MutableRefObject<SessionTmuxTargetRequestStore>;
    sessionDebugMetricsStoreRef: MutableRefObject<{
      recordRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
    }>;
    handleSocketServerMessageRef: MutableRefObject<((params: {
      sessionId: string;
      host: Host;
      ws: BridgeTransportSocket;
      debugScope: 'connect' | 'reconnect';
      rawFrameBytes?: number;
      onConnected: () => void;
      onFailure: (message: string, retryable: boolean) => void;
      onClosed: (reason?: string) => void;
    }, msg: ServerMessage) => void) | null>;
    handleSocketConnectedBaselineRef: MutableRefObject<((options: {
      sessionId: string;
      sessionName: string;
      ws: BridgeTransportSocket;
    }) => void) | null>;
    finalizeSocketFailureBaselineRef: MutableRefObject<((options: {
      sessionId: string;
      message: string;
      markCompleted: () => boolean;
    }) => { shouldContinue: boolean; manualClosed: boolean }) | null>;
  };
  readTargetTransportRuntimes: () => NetworkProbeTargetRuntime[];
  readTargetTransportRuntime: (targetKey: string) => NetworkProbeTargetRuntime | null;
  readTargetTerminalSocket: (targetKey: string) => BridgeTransportSocket | null;
  readSessionTargetControlSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTargetTerminalMuxReady: (sessionId: string) => boolean;
  readSessionTargetRuntime: (sessionId: string) => { key?: string; sessionIds: string[] } | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionTerminalChannel: (sessionId: string) => {
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  } | null;
  readSessionIdForTerminalChannel: (anchorSessionId: string, channelId: string) => string | null;
  readTargetSessionIdForTerminalChannel: (targetKey: string, channelId: string) => string | null;
  readOpeningSessionTerminalChannelsForTarget: (anchorSessionId: string) => Array<{
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  }>;
  readOpeningTerminalChannelsForTarget: (targetKey: string, prioritySessionId?: string | null) => Array<{
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  }>;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportToken: (sessionId: string) => string | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  writeSessionTransportHost: (sessionId: string, host: Host) => unknown;
  writeSessionTargetControlSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTargetTerminalSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  writeSessionTargetTerminalMuxReady: (sessionId: string, ready: boolean) => unknown;
  writeTargetTerminalSocket: (targetKey: string, socket: BridgeTransportSocket | null) => unknown;
  writeTargetTerminalMuxReady: (targetKey: string, ready: boolean) => unknown;
  writeSessionTransportSocket: (sessionId: string, socket: BridgeTransportSocket | null) => unknown;
  probeReconnectHost?: (bridgeHost: string, bridgePort: number) => Promise<boolean>;
  refreshHostForReconnect?: (host: Host) => Host;
  ensureSessionTerminalChannel: (sessionId: string, options?: { channelId?: string; now?: number; bodySubscribed?: boolean }) => {
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  } | null;
  writeSessionTerminalChannelState: (sessionId: string, state: 'opening' | 'open' | 'closing' | 'closed') => {
    channelId: string;
    sessionId: string;
    sessionName: string;
    targetKey: string;
    state: 'opening' | 'open' | 'closing' | 'closed';
    bodySubscribed: boolean;
    openedAt: number;
    closedAt: number | null;
  } | null;
  moveSessionTransportSocketAside: (sessionId: string) => BridgeTransportSocket | null;
  drainSessionSupersededSockets: (sessionId: string) => BridgeTransportSocket[];
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  clearHeartbeat: (sessionId: string, heartbeatOptions?: { heartbeatKey?: string }) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  setSessionHandshakeTimeout: (sessionId: string, callback: () => void, delayMs: number) => number;
  clearTailRefreshRuntime: (sessionId: string) => void;
  clearSessionPullState: (sessionId: string) => void;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  openDaemonTargetTransportSocket: (host: Host) => BridgeTransportSocket;
  applyTransportDiagnostics: (sessionId: string, socket: BridgeTransportSocket) => void;
  recordControlTransportRxBytes: (sessionId: string, data: string | ArrayBuffer) => void;
  recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => void;
  flushRuntimeDebugLogs: () => void;
  startSocketHeartbeat: (
    sessionId: string,
    ws: BridgeTransportSocket,
    finalizeFailure: (message: string, retryable: boolean) => void,
    heartbeatOptions?: { heartbeatKey?: string },
  ) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  readRequestedTerminalGeometry: (sessionId: string) => { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null;
  writeSessionRequestedTerminalGeometry: (sessionId: string, geometry: { cols?: number | null; rows?: number | null; widthMode?: TerminalWidthMode } | null) => unknown;
  handleTargetMuxMessage?: (payload: { requestId?: string; message: TerminalMuxTargetServerMessage }) => boolean;
}) {
  const cleanupControlSocket = (sessionId: string, shouldClose = false) => {
    cleanupControlSocketOrchestrationRuntime({
      sessionId,
      shouldClose,
      readSessionTargetControlSocket: options.readSessionTargetControlSocket,
      writeSessionTargetControlSocket: options.writeSessionTargetControlSocket,
    });
  };

  const primeSessionTransportSocket = (sessionId: string, ws: BridgeTransportSocket) => {
    primeSessionTransportSocketRuntime({
      sessionId,
      ws,
      writeSessionTransportSocket: options.writeSessionTransportSocket,
      updateSessionSync: options.updateSessionSync,
      heartbeatStore: options.refs.heartbeatStore,
    });
  };

  const primeTargetTerminalTransportSocket = (sessionId: string, ws: BridgeTransportSocket) => {
    options.writeSessionTargetTerminalSocket(sessionId, ws);
    options.writeSessionTargetTerminalMuxReady(sessionId, false);
    options.updateSessionSync(sessionId, { ws: null });
    const targetKey = options.readSessionTargetKey(sessionId);
    if (targetKey) {
      options.refs.heartbeatStore.recordPong(
        buildTargetTransportHeartbeatKey(targetKey),
        Date.now(),
      );
    }
  };

  const clearReconnectForSession = (sessionId: string) => {
    clearReconnectForSessionRuntime({
      sessionId,
      reconnectStore: options.refs.reconnectStore,
    });
  };

  const clearSupersededSockets = (sessionId: string, shouldClose = true) => {
    clearSupersededSocketsRuntime({
      sessionId,
      shouldClose,
      drainSessionSupersededSockets: options.drainSessionSupersededSockets,
    });
  };

  const cleanupSocket = (sessionId: string, shouldClose = false) => {
    cleanupSocketRuntime({
      sessionId,
      shouldClose,
      readSessionTransportSocket: options.readSessionTransportSocket,
      moveSessionTransportSocketAside: options.moveSessionTransportSocketAside,
      writeSessionTransportSocket: options.writeSessionTransportSocket,
      clearSupersededSockets,
      clearHeartbeat: options.clearHeartbeat,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      clearTailRefreshRuntime: options.clearTailRefreshRuntime,
      clearSessionPullState: options.clearSessionPullState,
      reconnectStore: options.refs.reconnectStore,
    });
  };

  const bindSessionTransportSocketLifecycle = (bindOptions: {
    sessionId: string;
    openRequestId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    finalizeFailure: (message: string, retryable: boolean) => void;
    onBeforeConnectSend?: (ctx: { sessionName: string }) => void;
    onConnected: () => void;
    onClosed?: (reason?: string) => void;
  }) => {
    bindSessionTransportSocketLifecycleOrchestrationRuntime({
      sessionId: bindOptions.sessionId,
      openRequestId: bindOptions.openRequestId,
      host: bindOptions.host,
      resolvedSessionName: getResolvedSessionName(bindOptions.host),
      ws: bindOptions.ws,
      debugScope: bindOptions.debugScope,
      readActiveSessionId: () => options.stateRef.current.activeSessionId,
      readSessionTransportSocket: options.readSessionTransportSocket,
      readSessionTransportToken: options.readSessionTransportToken,
      sendSocketPayload: options.sendSocketPayload,
      runtimeDebug: options.runtimeDebug,
      flushRuntimeDebugLogs: options.flushRuntimeDebugLogs,
      startSocketHeartbeat: options.startSocketHeartbeat,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      setSessionHandshakeTimeout: options.setSessionHandshakeTimeout,
      recordSessionRx: (sessionId: string, data: string | ArrayBuffer) => {
        if (typeof data === 'string') {
          try {
            const parsed = JSON.parse(data) as ServerMessage;
            if (parsed.type === 'pong') {
              options.refs.sessionDebugMetricsStoreRef.current.recordRxBytes(sessionId, data);
              return;
            }
          } catch {
            // fall through to normal rx accounting
          }
        }
        options.recordSessionRx(sessionId, data);
      },
      isSessionTransportActive: (sessionId: string) => (
        options.stateRef.current.activeSessionId === sessionId
        || Boolean(options.stateRef.current.liveSessionIds?.includes(sessionId))
      ),
      shouldAcceptSessionLiveBuffer: (sessionId: string) => {
        if (
          options.stateRef.current.activeSessionId === sessionId
          || Boolean(options.stateRef.current.liveSessionIds?.includes(sessionId))
        ) {
          return true;
        }
        const session = options.stateRef.current.sessions.find((candidate) => candidate.id === sessionId) || null;
        if (!session) {
          return false;
        }
        return !hasSessionLocalWindow(options.readSessionBufferSnapshot(sessionId));
      },
      handleSocketServerMessage: (params, msg) => {
        options.refs.handleSocketServerMessageRef.current?.(params, msg);
      },
      finalizeFailure: bindOptions.finalizeFailure,
      onBeforeConnectSend: bindOptions.onBeforeConnectSend,
      onConnected: bindOptions.onConnected,
      onClosed: bindOptions.onClosed,
      sessionHandshakeTimeoutMs: options.sessionHandshakeTimeoutMs,
      readRequestedTerminalGeometry: options.readRequestedTerminalGeometry,
    });
  };
  // Retained for direct (non-mux) transport binding; current WIP flow routes through the mux lifecycle.
  void bindSessionTransportSocketLifecycle;

  const buildMuxChannelCallbacks = (sessionId: string, ws: BridgeTransportSocket) => {
    const pending = getPendingSessionTransportOpenIntent(
      options.refs.pendingSessionTransportOpenIntentsRef.current,
      sessionId,
    );
    return {
      onChannelAllocated: () => {
        pending?.onChannelAllocated?.();
      },
      onConnected: () => {
        if (pending) {
          deletePendingSessionTransportOpenIntent(options.refs.pendingSessionTransportOpenIntentsRef.current, sessionId);
          pending.onConnected(ws);
          return;
        }
        const host = options.readSessionTransportHost(sessionId);
        options.refs.handleSocketConnectedBaselineRef.current?.({
          sessionId,
          sessionName: host ? getResolvedSessionName(host) : sessionId,
          ws,
        });
      },
      onFailure: (message: string, retryable: boolean) => {
        if (pending) {
          pending.finalizeFailure(message, retryable);
          return;
        }
        scheduleReconnect(sessionId, message, retryable);
      },
      onClosed: (reason?: string) => {
        if (pending) {
          deletePendingSessionTransportOpenIntent(options.refs.pendingSessionTransportOpenIntentsRef.current, sessionId);
          pending.onClosed?.(reason);
          return;
        }
        if (reason) {
          const channel = options.readSessionTerminalChannel(sessionId);
          const host = options.readSessionTransportHost(sessionId);
          const sessionName = channel?.sessionName || host?.sessionName || host?.name || sessionId;
          resolveMuxChannelClosedWithControlStatusRuntime({
            sessionId,
            sessionName,
            channelId: channel?.channelId || '',
            reason,
            shouldReconnectNow: (
              options.stateRef.current.activeSessionId === sessionId
              || Boolean(options.stateRef.current.liveSessionIds?.includes(sessionId))
            ),
            queryTargetSessions: () => manageTmuxSessionsOnOpenTransportRuntime({
              sessionId,
              message: { type: 'list-sessions' },
              pendingRequestsRef: options.refs.tmuxTargetRequestsRef,
              readSessionTransportResource: options.readSessionTransportResource,
              daemonConnection,
              sendSocketPayload: options.sendSocketPayload,
              runtimeDebug: options.runtimeDebug,
            }),
            readSessionTerminalChannel: options.readSessionTerminalChannel,
            scheduleReconnect,
            updateSessionSync: options.updateSessionSync,
            emitSessionStatus,
            runtimeDebug: options.runtimeDebug,
          });
        }
      },
    };
  };

  const submitTargetSocketFailure = (
    targetKey: string,
    failedSocket: BridgeTransportSocket,
    message: string,
  ) => {
    routeTargetSocketFailureRuntime({
      targetKey,
      failedSocket,
      message,
      readTargetTransportRuntime: options.readTargetTransportRuntime,
      writeTargetTerminalSocket: options.writeTargetTerminalSocket,
      writeTargetTerminalMuxReady: options.writeTargetTerminalMuxReady,
      clearHeartbeat: options.clearHeartbeat,
      runtimeDebug: options.runtimeDebug,
      handleAnchoredFailure: (anchorSessionId) => handleTargetMuxTransportFailureRuntime({
        anchorSessionId,
        message,
        failedSocket,
        readSessionTargetRuntime: options.readSessionTargetRuntime,
        readSessionTerminalChannel: options.readSessionTerminalChannel,
        writeSessionTerminalChannelState: options.writeSessionTerminalChannelState,
        writeSessionTargetTerminalSocket: options.writeSessionTargetTerminalSocket,
        writeSessionTargetTerminalMuxReady: options.writeSessionTargetTerminalMuxReady,
        clearHeartbeat: options.clearHeartbeat,
        clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
        pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
        updateSessionSync: options.updateSessionSync,
        scheduleReconnect,
        runtimeDebug: options.runtimeDebug,
      }),
    });
  };

  const bindTargetMuxTransportSocketLifecycle = (bindOptions: {
    sessionId: string;
    host: Host;
    ws: BridgeTransportSocket;
    debugScope: 'connect' | 'reconnect';
    finalizeFailure: (message: string, retryable: boolean) => void;
  }) => {
    const targetKey = options.readSessionTargetKey(bindOptions.sessionId) || '';
    const targetHeartbeatKey = targetKey ? buildTargetTransportHeartbeatKey(targetKey) : '';
    bindTargetMuxTransportSocketLifecycleRuntime({
      sessionId: bindOptions.sessionId,
      targetKey,
      targetHeartbeatKey,
      host: bindOptions.host,
      ws: bindOptions.ws,
      debugScope: bindOptions.debugScope,
      clientDeviceId: options.clientDeviceId,
      readTargetTerminalSocket: options.readTargetTerminalSocket,
      readRequestedTerminalGeometry: options.readRequestedTerminalGeometry,
      getOpeningTerminalChannelsForTarget: options.readOpeningTerminalChannelsForTarget,
      readPrioritySessionId: () => options.stateRef.current.activeSessionId,
      setTargetMuxReady: options.writeTargetTerminalMuxReady,
      sendSocketPayload: options.sendSocketPayload,
      applyTransportDiagnostics: options.applyTransportDiagnostics,
      startSocketHeartbeat: options.startSocketHeartbeat,
      recordTargetServerActivity: (heartbeatKey) => {
        options.refs.heartbeatStore.recordServerActivity(heartbeatKey, Date.now());
        if (targetKey) {
          options.refs.targetNetworkProbeRuntime.recordTargetActivity(targetKey, bindOptions.ws);
        }
      },
      recordTargetPong: (heartbeatKey) => {
        options.refs.heartbeatStore.recordPong(heartbeatKey, Date.now());
      },
      startMuxHandshakeTimeout: startMuxHandshakeTimeoutForSession,
      runtimeDebug: options.runtimeDebug,
      finalizeFailure: (message) => {
        submitTargetSocketFailure(targetKey, bindOptions.ws, message);
      },
      handleTargetMuxServerFrame: (frame, rawFrameBytes, rawFrameData) => {
        handleTargetMuxServerFrameRuntime({
          anchorSessionId: bindOptions.sessionId,
          host: bindOptions.host,
          ws: bindOptions.ws,
          debugScope: bindOptions.debugScope,
          rawFrameBytes,
          rawFrameData,
          frame,
          resolveSessionIdForChannel: (channelId) => options.readTargetSessionIdForTerminalChannel(targetKey, channelId),
          readSessionTerminalChannelBodySubscribed: (sessionId) => (
            options.readSessionTerminalChannel(sessionId)?.bodySubscribed ?? null
          ),
          updateSessionTerminalChannelState: options.writeSessionTerminalChannelState,
          sendSocketPayload: options.sendSocketPayload,
          handleSocketServerMessage: (params, msg) => {
            options.refs.handleSocketServerMessageRef.current?.(params, msg);
          },
          buildChannelCallbacks: (sessionId) => buildMuxChannelCallbacks(sessionId, bindOptions.ws),
          handleTargetMuxMessage: options.handleTargetMuxMessage,
          recordSessionRx: options.recordSessionRx,
          runtimeDebug: options.runtimeDebug,
        });
      },
    });
  };

  const daemonConnection = createClientDaemonConnection({
    readSessionTransportResource: options.readSessionTransportResource,
    sendSocketPayload: options.sendSocketPayload,
    openSessionTargetTransport: ({ sessionId, host, debugScope, finalizeFailure }) => {
      const ws = options.openDaemonTargetTransportSocket(host);
      options.applyTransportDiagnostics(sessionId, ws);
      primeTargetTerminalTransportSocket(sessionId, ws);
      bindTargetMuxTransportSocketLifecycle({
        sessionId,
        host,
        ws,
        debugScope,
        finalizeFailure,
      });
      return ws;
    },
  });

  const notifyTargetNetworkSignal = (signal: SessionTargetNetworkSignal) => (
    notifyTargetNetworkSignalRuntime({
      signal,
      targetRuntimes: options.readTargetTransportRuntimes(),
      targetNetworkProbeRuntime: options.refs.targetNetworkProbeRuntime,
      wakeScheduledReconnects: () => {
        for (const sessionId of options.refs.reconnectStore.sessionIds()) {
          const reconnectRuntime = options.refs.reconnectStore.read(sessionId);
          if (reconnectRuntime?.phase !== 'scheduled') {
            continue;
          }
          scheduleReconnect(sessionId, 'network recovered', true, {
            immediate: true,
            force: true,
          });
          options.runtimeDebug('session.reconnect.network-recovery-wake', {
            sessionId,
            source: signal.source,
            attempt: reconnectRuntime.attempt,
          });
        }
      },
      sendTargetProbe: (_targetKey, probeSocket, sentAt) => {
        probeSocket.send(JSON.stringify(buildTerminalMuxPing(sentAt)));
      },
      submitTargetSocketFailure,
      runtimeDebug: options.runtimeDebug,
    })
  );

  const startMuxHandshakeTimeoutForSession = (sessionId: string) => {
    options.setSessionHandshakeTimeout(sessionId, () => {
      const pending = getPendingSessionTransportOpenIntent(
        options.refs.pendingSessionTransportOpenIntentsRef.current,
        sessionId,
      );
      pending?.finalizeFailure('terminal mux channel open timeout', true);
    }, options.sessionHandshakeTimeoutMs);
  };

  function openSessionMuxChannelByIntent(intent: PendingSessionTransportOpenIntent) {
    // The mux handshake timeout is NOT started here: it would count socket
    // candidate attempts (up to ~13.9s serial) against a 4s budget and cut
    // healthy-but-slow candidates. It is started from the socket onopen
    // (mux-hello) path and from the already-open branches of the open runtime
    // so it only covers hello -> mux-ready -> channel-open -> allocated.
    options.clearSessionHandshakeTimeout(intent.sessionId);
    openSessionMuxChannelByIntentRuntime({
      intent,
      readSessionTargetTerminalSocket: options.readSessionTargetTerminalSocket,
      isSessionTargetMuxReady: options.readSessionTargetTerminalMuxReady,
      ensureSessionTerminalChannel: options.ensureSessionTerminalChannel,
      isSessionBodySubscribed: (sessionId) => {
        const liveSessionIds = new Set(options.stateRef.current.liveSessionIds || []);
        return options.stateRef.current.activeSessionId === sessionId || liveSessionIds.has(sessionId);
      },
      updateSessionTerminalChannelState: options.writeSessionTerminalChannelState,
      readRequestedTerminalGeometry: options.readRequestedTerminalGeometry,
      sendSocketPayload: options.sendSocketPayload,
      startHandshakeTimeout: () => startMuxHandshakeTimeoutForSession(intent.sessionId),
      daemonConnection,
      runtimeDebug: options.runtimeDebug,
    });
  }

  const startReconnectAttempt = (sessionId: string) => {
    startReconnectAttemptRuntime({
      sessionId,
      refs: {
        reconnectStore: options.refs.reconnectStore,
      },
      readSessionTransportHost: options.readSessionTransportHost,
      computeReconnectDelay,
      updateSessionSync: options.updateSessionSync,
      writeSessionTransportToken: options.writeSessionTransportToken,
      writeSessionTransportHost: options.writeSessionTransportHost,
      queueReconnectTransportOpenIntent,
      probeReconnectHost: options.probeReconnectHost,
      recordReconnectHostProbe: (result) => {
        options.runtimeDebug('session.reconnect.http-probe', {
          sessionId: result.sessionId,
          candidates: result.candidates,
        });
      },
      refreshHostForReconnect: options.refreshHostForReconnect,
    });
  };

  const scheduleReconnect = (
    sessionId: string,
    message: string,
    retryable = true,
    reconnectOptions?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => {
    scheduleReconnectRuntime({
      sessionId,
      message,
      retryable,
      reconnectOptions,
      refs: {
        reconnectStore: options.refs.reconnectStore,
        stateRef: options.stateRef as MutableRefObject<{ sessions: Session[]; activeSessionId: string | null; liveSessionIds?: string[] }>,
      },
      readSessionTransportHost: options.readSessionTransportHost,
      shouldAutoReconnectSessionFn: shouldAutoReconnectSession,
      updateSessionSync: options.updateSessionSync,
      emitSessionStatus,
      startReconnectAttempt,
    });
  };

  const queueSessionTransportOpenIntent = (intentOptions: QueueSessionTransportOpenIntentOptions) => {
    const terminalReadyTimeoutMs = options.sessionTerminalReadyTimeoutMs ?? options.sessionHandshakeTimeoutMs;
    queueSessionTransportOpenIntentRuntime({
      intentOptions: {
        ...intentOptions,
        onChannelAllocated: () => {
          intentOptions.onChannelAllocated?.();
          options.setSessionHandshakeTimeout(intentOptions.sessionId, () => {
            const pending = getPendingSessionTransportOpenIntent(
              options.refs.pendingSessionTransportOpenIntentsRef.current,
              intentOptions.sessionId,
            );
            pending?.finalizeFailure('terminal mux channel ready timeout', true);
          }, terminalReadyTimeoutMs);
        },
      },
      clearSessionHandshakeTimeout: options.clearSessionHandshakeTimeout,
      finalizeSocketFailureBaseline: (baselineOptions) => {
        const result = options.refs.finalizeSocketFailureBaselineRef.current?.(baselineOptions);
        if (!result) {
          throw new Error('finalizeSocketFailureBaseline handler unavailable');
        }
        return result;
      },
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      openSessionMuxChannelByIntent,
    });
  };

  const applyTransportOpenConnectedEffects = (connectedOptions: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    sessionName: string;
    ws: BridgeTransportSocket;
  }) => {
    applyTransportOpenConnectedEffectsRuntime({
      ...connectedOptions,
      runtimeDebug: options.runtimeDebug,
      activeSessionId: options.stateRef.current.activeSessionId,
      clearSupersededSockets,
      handleSocketConnectedBaseline: (connectedOptions) => {
        options.refs.handleSocketConnectedBaselineRef.current?.(connectedOptions);
      },
    });
  };

  const applyTransportOpenLiveFailureEffects = (failureOptions: {
    sessionId: string;
    debugScope: 'connect' | 'reconnect';
    message: string;
    retryable: boolean;
  }) => {
    applyTransportOpenLiveFailureEffectsRuntime({
      ...failureOptions,
      cleanupSocket,
      pendingSessionTransportOpenIntentsRef: options.refs.pendingSessionTransportOpenIntentsRef,
      writeSessionTransportToken: options.writeSessionTransportToken,
      clearSupersededSockets,
      setScheduleStateForSession: options.setScheduleStateForSession,
      scheduleReconnect,
    });
  };


  const handleReconnectBeforeConnectSend = (sessionId: string, sessionName: string) => {
    handleReconnectBeforeConnectSendRuntime({
      sessionId,
      sessionName,
      updateSessionSync: options.updateSessionSync,
      setScheduleStateForSession: options.setScheduleStateForSession,
    });
  };

  const handleReconnectHandshakeFailure = (failureOptions: {
    sessionId: string;
    message: string;
    retryable: boolean;
  }) => {
    handleReconnectHandshakeFailureRuntime({
      ...failureOptions,
      reconnectStore: options.refs.reconnectStore,
      clearSupersededSockets,
      updateSessionSync: options.updateSessionSync,
      emitSessionStatus,
      shouldContinueRetryableReconnect: (sessionId) => shouldAutoReconnectSession({
        sessionId,
        activeSessionId: options.stateRef.current.activeSessionId,
        liveSessionIds: options.stateRef.current.liveSessionIds,
      }),
      scheduleReconnect,
    });
  };

  const buildReconnectTransportOpenIntentOptions = (
    sessionId: string,
    host: Host,
  ): QueueSessionTransportOpenIntentOptions => {
    return buildReconnectTransportOpenIntentOptionsRuntime({
      sessionId,
      host,
      handleReconnectBeforeConnectSend,
      handleReconnectHandshakeFailure,
      applyTransportOpenLiveFailureEffects,
      reconnectStore: options.refs.reconnectStore,
      applyTransportOpenConnectedEffects,
      emitSessionStatus,
      updateSessionSync: (_id, updates) => {
        options.updateSessionSync(_id, updates);
      },
    });
  };

  const buildConnectTransportOpenIntentOptions = (
    sessionId: string,
    host: Host,
  ): QueueSessionTransportOpenIntentOptions => {
    return buildConnectTransportOpenIntentOptionsRuntime({
      sessionId,
      host,
      applyTransportOpenLiveFailureEffects,
      scheduleReconnect,
      applyTransportOpenConnectedEffects,
      emitSessionStatus,
      updateSessionSync: (_id, updates) => {
        options.updateSessionSync(_id, updates);
      },
    });
  };

  function queueReconnectTransportOpenIntent(sessionId: string, host: Host) {
    queueTransportOpenIntentRuntime({
      sessionId,
      host,
      mode: 'reconnect',
      queueSessionTransportOpenIntent,
      buildReconnectTransportOpenIntentOptions,
      buildConnectTransportOpenIntentOptions,
    });
  }

  const queueConnectTransportOpenIntent = (sessionId: string, host: Host) => {
    queueTransportOpenIntentRuntime({
      sessionId,
      host,
      
      mode: 'connect',
      queueSessionTransportOpenIntent,
      buildReconnectTransportOpenIntentOptions,
      buildConnectTransportOpenIntentOptions,
    });
  };

  const sendTerminalResize = (sessionId: string, cols?: number | null, rows?: number | null, widthMode?: TerminalWidthMode) => {
    return sendTerminalResizeRuntime({
      sessionId,
      ws: daemonConnection.readSessionSocket(sessionId),
      sendSocketPayload: options.sendSocketPayload,
      writeRequestedTerminalGeometry: options.writeSessionRequestedTerminalGeometry,
      cols,
      rows,
      widthMode,
    });
  };

  return {
    cleanupControlSocket,
    primeSessionTransportSocket,
    clearReconnectForSession,
    clearSupersededSockets,
    cleanupSocket,
    scheduleReconnect,
    queueConnectTransportOpenIntent,
    notifyTargetNetworkSignal,
    sendTerminalResize,
  };
}

function emitSessionStatus(sessionId: string, type: 'closed' | 'error', message?: string) {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('zterm:session-status', { detail: { sessionId, type, message } }));
}
