import { useRef, useState } from 'react';
import type { Host, ServerMessage, SessionScheduleState } from '../lib/types';
import { createFileTransferMessageRuntime } from '../lib/file-transfer-message-runtime';
import { createRemoteScreenshotRuntime } from '../lib/remote-screenshot-runtime';
import { createRemoteWindowMessageRuntime } from '../lib/remote-window-message-runtime';
import { createRemoteWindowReceiverRuntime } from '../lib/remote-window-receiver-runtime';
import { createSessionDebugMetricsStore } from '../lib/session-debug-metrics-store';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { createSessionTransportRuntimeStore } from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { createSessionBufferStore } from '../lib/session-buffer-store';
import { createSessionRenderGate } from '../lib/session-render-gate';
import { createSessionHeadStore } from '../lib/session-head-store';
import { runtimeDebug } from '../lib/runtime-debug';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { SessionTmuxTargetRequestStore } from './session-context-tmux-management-runtime';
import type { SessionVisibleRangeState } from './session-visible-range-helpers';
import type { SessionPullStates } from './session-pull-state-helpers';
import type { RevisionResetExpectation } from './session-context-core';

type HandleSocketConnectedBaselineFn = (options: {
  sessionId: string;
  sessionName: string;
  ws: BridgeTransportSocket;
}) => void;

type FinalizeSocketFailureBaselineFn = (options: {
  sessionId: string;
  message: string;
  markCompleted: () => boolean;
}) => { shouldContinue: boolean; manualClosed: boolean };

type HandleSocketServerMessageFn = (params: {
  sessionId: string;
  host: Host;
  ws: BridgeTransportSocket;
  debugScope: 'connect' | 'reconnect';
  onConnected: () => void;
  onFailure: (message: string, retryable: boolean) => void;
}, msg: ServerMessage) => void;

export function useSessionProviderRuntime(options: {
  appForegroundActive?: boolean;
  foregroundResumeEpoch?: number;
}) {
  const [scheduleStates, setScheduleStates] = useState<Record<string, SessionScheduleState>>({});
  const sessionDebugMetricsStoreRef = useRef(createSessionDebugMetricsStore());
  const transportRuntimeStoreRef = useRef(createSessionTransportRuntimeStore());
  const sessionBufferStoreRef = useRef(createSessionBufferStore());
  const sessionHeadStoreRef = useRef(createSessionHeadStore());
  const sessionRenderGateRef = useRef(createSessionRenderGate({
    liveBufferStore: sessionBufferStoreRef.current,
    liveHeadStore: sessionHeadStoreRef.current,
    recordSessionRenderCommit: (sessionId: string) => {
      sessionDebugMetricsStoreRef.current.recordRenderCommit(sessionId);
    },
    runtimeDebug,
  }));
  const sessionHeartbeatStoreRef = useRef(createSessionHeartbeatStore());
  const sessionReconnectStoreRef = useRef(createSessionReconnectStore());
  const handshakeTimeoutsRef = useRef<Map<string, number>>(new Map());
  const sessionVisibleRangeRef = useRef<Map<string, SessionVisibleRangeState>>(new Map());
  const lastActivatedSessionIdRef = useRef<string | null>(null);
  const lastActiveReentryAtRef = useRef<Map<string, number>>(new Map());
  const lastConnectedBaselineAtRef = useRef<Map<string, number>>(new Map());
  const connectedBaselineBurstGuardRef = useRef<Set<string>>(new Set());
  const sessionRevisionResetRef = useRef<Map<string, RevisionResetExpectation>>(new Map());
  const sessionTailRefreshStoreRef = useRef(createSessionTailRefreshStore());
  const lastHeadRequestAtRef = useRef<Map<string, number>>(new Map());
  const sameRevisionChunkFrameRef = useRef<Map<string, any>>(new Map());
  const sessionPullStateRef = useRef<Map<string, SessionPullStates>>(new Map());
  const sessionAttachTokensRef = useRef<Map<string, string>>(new Map());
  const pendingSessionTransportOpenIntentsRef = useRef<Map<string, PendingSessionTransportOpenIntent>>(new Map());
  const tmuxTargetRequestsRef = useRef<SessionTmuxTargetRequestStore>(new Map());
  const activeBodySubscriptionSuppressedRef = useRef(false);
  const remoteScreenshotRuntimeRef = useRef(createRemoteScreenshotRuntime());
  const remoteWindowTargetCatalogCacheRef = useRef(new Map());
  const remoteWindowReceiverRuntimeRef = useRef(createRemoteWindowReceiverRuntime());
  const remoteWindowMessageRuntimeRef = useRef(createRemoteWindowMessageRuntime({
    onStreamIceCandidate: (payload) => remoteWindowReceiverRuntimeRef.current.addIceCandidate(payload),
    onStreamStatus: (payload) => {
      remoteWindowReceiverRuntimeRef.current.handleStatus(payload);
    },
    onListenerError: (phase, error) => {
      console.error(`[SessionContext] remote-window receiver listener error (${phase}):`, error);
    },
  }));
  const fileTransferMessageRuntimeRef = useRef(createFileTransferMessageRuntime({
    onRemoteScreenshotStatus: (payload) => {
      remoteScreenshotRuntimeRef.current.handleStatus(payload);
    },
    onRemoteScreenshotChunk: (payload) => {
      remoteScreenshotRuntimeRef.current.handleChunk(payload);
    },
    onRemoteScreenshotComplete: (payload) => {
      remoteScreenshotRuntimeRef.current.handleComplete(payload);
    },
    onRemoteScreenshotError: (payload) => {
      remoteScreenshotRuntimeRef.current.handleError(payload);
    },
    onListenerError: (phase, error) => {
      console.error(`[SessionContext] fileTransfer listener error (${phase}):`, error);
    },
  }));
  const foregroundActiveRef = useRef(options.appForegroundActive !== false);
  const handleSocketConnectedBaselineRef = useRef<HandleSocketConnectedBaselineFn | null>(null);
  const finalizeSocketFailureBaselineRef = useRef<FinalizeSocketFailureBaselineFn | null>(null);
  const handleSocketServerMessageRef = useRef<HandleSocketServerMessageFn | null>(null);

  return {
    scheduleStates,
    setScheduleStates,
    refs: {
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionBufferStoreRef,
      sessionRenderGateRef,
      sessionHeadStoreRef,
      sessionHeartbeatStoreRef,
      sessionReconnectStoreRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      connectedBaselineBurstGuardRef,
      sessionRevisionResetRef,
      sessionTailRefreshStoreRef,
      lastHeadRequestAtRef,
      sameRevisionChunkFrameRef,
      sessionPullStateRef,
      sessionAttachTokensRef,
      pendingSessionTransportOpenIntentsRef,
      tmuxTargetRequestsRef,
      activeBodySubscriptionSuppressedRef,
      remoteScreenshotRuntimeRef,
      remoteWindowTargetCatalogCacheRef,
      remoteWindowMessageRuntimeRef,
      remoteWindowReceiverRuntimeRef,
      fileTransferMessageRuntimeRef,
      foregroundActiveRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
      handleSocketServerMessageRef,
    },
  };
}
