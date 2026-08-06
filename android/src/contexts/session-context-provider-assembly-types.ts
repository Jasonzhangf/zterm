import type { Dispatch, MutableRefObject, SetStateAction } from 'react';
import type { BridgeSettings } from '../lib/bridge-settings';
import type { ClientDaemonConnection } from '../lib/client-daemon-connection';
import type { FileTransferMessageRuntime } from '../lib/file-transfer-message-runtime';
import type { RemoteScreenshotRuntime } from '../lib/remote-screenshot-runtime';
import type { RemoteWindowMessageRuntime } from '../lib/remote-window-message-runtime';
import type { RemoteWindowReceiverRuntime } from '../lib/remote-window-receiver-runtime';
import type { SessionBufferStore } from '../lib/session-buffer-store';
import type { SessionDebugMetricsStore } from '../lib/session-debug-metrics-store';
import type { SessionHeadStore } from '../lib/session-head-store';
import type { SessionHeartbeatStore } from '../lib/session-heartbeat-store';
import type { SessionReconnectStore } from '../lib/session-reconnect-store';
import type { SessionRenderGate } from '../lib/session-render-gate';
import type { SessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import type {
  SessionTerminalChannelRuntime,
  SessionTransportResource,
  SessionTransportRuntime,
  SessionTransportRuntimeStore,
  TargetTransportRuntime,
} from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import type {
  Host,
  Session,
  SessionBufferState,
  SessionScheduleState,
  ServerMessage,
} from '../lib/types';
import type { BufferFrameAssemblyResourceState } from './session-context-buffer-runtime';
import type {
  RevisionResetExpectation,
  SessionAction,
  SessionContextValue,
  SessionManagerState,
} from './session-context-core';
import type {
  SessionMessageAssembliesResult,
  SessionSocketConnectedBaselineOptions,
  SessionSocketFailureBaselineOptions,
  SessionSocketFailureBaselineResult,
  SessionSocketServerMessageOptions,
} from './session-context-message-assemblies';
import type { RemoteWindowTargetCatalogCacheStore } from './session-context-remote-window-runtime';
import type { SessionTmuxTargetRequestStore } from './session-context-tmux-management-runtime';
import type {
  SessionTargetNetworkProbeRuntime,
  SessionTargetNetworkSignal,
} from './session-context-target-network-probe-runtime';
import type { SessionPullStates } from './session-pull-state-helpers';
import type { SessionAttachmentStore } from '../lib/session-attachment-store';
import type { SessionAttachmentFetchRuntime } from '../lib/session-attachment-fetch-runtime';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { SessionVisibleRangeState } from './session-visible-range-helpers';

export type HandleSocketConnectedBaselineFn = (
  options: SessionSocketConnectedBaselineOptions,
) => void;

export type FinalizeSocketFailureBaselineFn = (
  options: SessionSocketFailureBaselineOptions,
) => SessionSocketFailureBaselineResult;

export type HandleSocketServerMessageFn = (
  params: SessionSocketServerMessageOptions,
  msg: ServerMessage,
) => void;

export type SessionRequestedTerminalGeometry = {
  cols?: number | null;
  rows?: number | null;
  widthMode?: 'adaptive-phone' | 'mirror-fixed';
} | null;

export interface SessionProviderRuntimeRefs {
  sessionDebugMetricsStoreRef: MutableRefObject<SessionDebugMetricsStore>;
  transportRuntimeStoreRef: MutableRefObject<SessionTransportRuntimeStore>;
  sessionBufferStoreRef: MutableRefObject<SessionBufferStore>;
  sessionRenderGateRef: MutableRefObject<SessionRenderGate>;
  sessionHeadStoreRef: MutableRefObject<SessionHeadStore>;
  sessionHeartbeatStoreRef: MutableRefObject<SessionHeartbeatStore>;
  sessionReconnectStoreRef: MutableRefObject<SessionReconnectStore>;
  targetNetworkProbeRuntimeRef: MutableRefObject<SessionTargetNetworkProbeRuntime>;
  handshakeTimeoutsRef: MutableRefObject<Map<string, number>>;
  sessionVisibleRangeRef: MutableRefObject<Map<string, SessionVisibleRangeState>>;
  lastActivatedSessionIdRef: MutableRefObject<string | null>;
  lastActiveReentryAtRef: MutableRefObject<Map<string, number>>;
  lastConnectedBaselineAtRef: MutableRefObject<Map<string, number>>;
  lastBackgroundEnteredAtRef: MutableRefObject<Map<string, number>>;
  connectedBaselineBurstGuardRef: MutableRefObject<Set<string>>;
  sessionRevisionResetRef: MutableRefObject<Map<string, RevisionResetExpectation>>;
  sessionTailRefreshStoreRef: MutableRefObject<SessionTailRefreshStore>;
  lastHeadRequestAtRef: MutableRefObject<Map<string, number>>;
  bufferFrameAssemblyRef: MutableRefObject<Map<string, BufferFrameAssemblyResourceState>>;
  sessionPullStateRef: MutableRefObject<Map<string, SessionPullStates>>;
  sessionAttachTokensRef: MutableRefObject<Map<string, string>>;
  pendingSessionTransportOpenIntentsRef: MutableRefObject<Map<string, PendingSessionTransportOpenIntent>>;
  tmuxTargetRequestsRef: MutableRefObject<SessionTmuxTargetRequestStore>;
  activeBodySubscriptionSuppressedRef: MutableRefObject<boolean>;
  remoteScreenshotRuntimeRef: MutableRefObject<RemoteScreenshotRuntime>;
  remoteWindowTargetCatalogCacheRef: MutableRefObject<RemoteWindowTargetCatalogCacheStore>;
  remoteWindowMessageRuntimeRef: MutableRefObject<RemoteWindowMessageRuntime>;
  remoteWindowReceiverRuntimeRef: MutableRefObject<RemoteWindowReceiverRuntime>;
  fileTransferMessageRuntimeRef: MutableRefObject<FileTransferMessageRuntime>;
  foregroundActiveRef: MutableRefObject<boolean>;
  handleSocketConnectedBaselineRef: MutableRefObject<HandleSocketConnectedBaselineFn | null>;
  finalizeSocketFailureBaselineRef: MutableRefObject<FinalizeSocketFailureBaselineFn | null>;
  handleSocketServerMessageRef: MutableRefObject<HandleSocketServerMessageFn | null>;
  attachmentStoreRef: MutableRefObject<SessionAttachmentStore>;
  attachmentFetchRuntimeRef: MutableRefObject<SessionAttachmentFetchRuntime>;
}

export interface SessionProviderAssembliesSharedOptions {
  appForegroundActive?: boolean;
  foregroundResumeEpoch?: number;
  state: SessionManagerState;
  stateRef: MutableRefObject<SessionManagerState>;
  dispatch: Dispatch<SessionAction>;
  scheduleStates: Record<string, SessionScheduleState>;
  scheduleStatesRef: MutableRefObject<Record<string, SessionScheduleState>>;
  setScheduleStates: Dispatch<SetStateAction<Record<string, SessionScheduleState>>>;
  bridgeSettings: BridgeSettings;
  terminalCacheLines: number;
  wsUrl?: string;
  refs: SessionProviderRuntimeRefs;
}

export interface SessionProviderCoreAssembliesResult {
  getSessionRenderBufferSnapshot: SessionContextValue['getSessionRenderBufferSnapshot'];
  getSessionBufferStore: SessionContextValue['getSessionBufferStore'];
  getSessionRenderBufferStore: SessionContextValue['getSessionRenderBufferStore'];
  getSessionHeadStore: SessionContextValue['getSessionHeadStore'];
  flushRuntimeDebugLogs: () => void;
  clearReconnectForSession: (sessionId: string) => void;
  writeSessionTransportHost: (sessionId: string, host: Host) => SessionTransportRuntime | null | undefined | unknown;
  writeSessionTransportToken: (sessionId: string, token: string | null) => string | null;
  scheduleReconnect: (
    sessionId: string,
    message: string,
    retryable?: boolean,
    options?: { immediate?: boolean; resetAttempt?: boolean; force?: boolean },
  ) => void;
  readSessionBufferSnapshot: (sessionId: string) => SessionBufferState;
  setActiveSessionSync: (id: string) => void;
  setLiveSessionIdsSync: (ids: string[]) => void;
  setActiveBodySubscriptionSuppressedSync: (suppressed: boolean, reason?: string) => void;
  createSessionSync: (session: Session) => void;
  deleteSessionSync: (id: string) => void;
  moveSessionSync: (id: string, toIndex: number) => void;
  updateSessionSync: (id: string, updates: Partial<Session>) => void;
  setSessionTitleSync: (id: string, title: string) => void;
  isSessionTransportActive: (sessionId: string) => boolean;
  shouldAcceptSessionLiveBuffer: (sessionId: string) => boolean;
  hasPendingSessionTransportOpen: (sessionId: string) => boolean;
  isPendingSessionTransportOpenStale: (sessionId: string, staleAfterMs?: number) => boolean;
  isReconnectInFlight: (sessionId: string) => boolean;
  resolveSessionCacheLines: (rows?: number | null) => number;
  scheduleSessionRenderCommit: (sessionId: string) => void;
  markPendingInputTailRefresh: (sessionId: string, localRevision: number) => boolean;
  resetSessionTransportPullBookkeeping: (sessionId: string, reason: string) => void;
  isSessionTransportActivityStale: (sessionId: string) => boolean;
  sendSocketPayload: (sessionId: string, ws: BridgeTransportSocket, data: string | ArrayBuffer) => void;
  setScheduleStateForSession: (
    sessionId: string,
    nextState: SessionScheduleState | ((current: SessionScheduleState) => SessionScheduleState),
  ) => void;
  clearSessionHandshakeTimeout: (sessionId: string) => void;
  cleanupControlSocket: (sessionId: string, shouldClose?: boolean) => void;
  cleanupSocket: (sessionId: string, shouldClose?: boolean) => void;
  queueConnectTransportOpenIntent: (sessionId: string, host: Host) => void;
  sendTerminalResize: (
    sessionId: string,
    cols?: number | null,
    rows?: number | null,
    widthMode?: 'adaptive-phone' | 'mirror-fixed',
  ) => boolean;
  notifyTargetNetworkSignal: (
    signal: SessionTargetNetworkSignal,
  ) => void;
  readTargetTransportRuntimes: () => TargetTransportRuntime[];
  readSessionTransportResource: (sessionId: string) => SessionTransportResource;
  readSessionTransportSocket: (sessionId: string) => BridgeTransportSocket | null;
  readSessionTransportHost: (sessionId: string) => Host | null;
  readSessionTransportRuntime: (sessionId: string) => SessionTransportRuntime | null;
  readSessionTargetRuntime: (sessionId: string) => TargetTransportRuntime | null;
  readSessionTerminalChannel: (sessionId: string) => SessionTerminalChannelRuntime | null;
  readSessionTargetKey: (sessionId: string) => string | null;
  readSessionRequestedTerminalGeometry: (sessionId: string) => SessionRequestedTerminalGeometry;
  writeSessionRequestedTerminalGeometry: (
    sessionId: string,
    geometry: SessionRequestedTerminalGeometry,
  ) => SessionRequestedTerminalGeometry | SessionTransportRuntime['requestedTerminalGeometry'] | null | undefined;
  clearSessionTransportRuntime: (sessionId: string) => SessionTransportRuntime | null | undefined;
  requestSessionBufferSync: SessionMessageAssembliesResult['requestSessionBufferSync'];
  requestSessionBufferHead: SessionMessageAssembliesResult['requestSessionBufferHead'];
  resolveTerminalRefreshCadence: (sessionId?: string | null) => {
    headTickMs: number;
    headStalePingMs: number;
    pullRequestStaleMs: number;
    minTailRefreshGapMs?: number;
    readingSyncDelayMs?: number;
  };
  daemonConnection: ClientDaemonConnection;
}
