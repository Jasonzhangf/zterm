import { useRef, useState } from 'react';
import type { Host, ServerMessage, SessionScheduleState } from '../lib/types';
import { SessionStore } from '../lib/session/SessionStore';
import { createFileTransferMessageRuntime } from '../lib/file-transfer-message-runtime';
import { createRemoteScreenshotRuntime } from '../lib/remote-screenshot-runtime';
import { createSessionDebugMetricsStore } from '../lib/session-debug-metrics-store';
import { createSessionTransportRuntimeStore } from '../lib/session-transport-runtime';
import type { BridgeTransportSocket } from '../lib/traversal/types';
import { createSessionBufferStore } from '../lib/session-buffer-store';
import { createSessionHeadStore } from '../lib/session-head-store';
import type {
  PendingSessionTransportOpenIntent,
  SessionBufferHeadState,
  SessionPullStates,
  SessionVisibleRangeState,
} from './session-sync-helpers';
import type {
  RevisionResetExpectation,
  SessionReconnectRuntime,
} from './session-context-core';

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
}) {
  const sessionStoreRef = useRef(new SessionStore());
  const sessionStore = sessionStoreRef.current;
  const [scheduleStates, setScheduleStates] = useState<Record<string, SessionScheduleState>>({});
  const sessionDebugMetricsStoreRef = useRef(createSessionDebugMetricsStore());
  const transportRuntimeStoreRef = useRef(createSessionTransportRuntimeStore());
  const sessionBufferStoreRef = useRef(createSessionBufferStore());
  const sessionHeadStoreRef = useRef(createSessionHeadStore());
  const pingIntervalsRef = useRef<Map<string, ReturnType<typeof setInterval>>>(new Map());
  const handshakeTimeoutsRef = useRef<Map<string, number>>(new Map());
  const sessionVisibleRangeRef = useRef<Map<string, SessionVisibleRangeState>>(new Map());
  const lastPongAtRef = useRef<Map<string, number>>(new Map());
  const lastServerActivityAtRef = useRef<Map<string, number>>(new Map());
  const staleTransportProbeAtRef = useRef<Map<string, number>>(new Map());
  const viewportSizeRef = useRef<Map<string, { cols: number; rows: number }>>(new Map());
  const reconnectRuntimesRef = useRef<Map<string, SessionReconnectRuntime>>(new Map());
  const manualCloseRef = useRef<Set<string>>(new Set());
  const pendingInputQueueRef = useRef<Map<string, string[]>>(new Map());
  const lastActivatedSessionIdRef = useRef<string | null>(null);
  const sessionBufferHeadsRef = useRef<Map<string, SessionBufferHeadState>>(new Map());
  const sessionRevisionResetRef = useRef<Map<string, RevisionResetExpectation>>(new Map());
  const pendingInputTailRefreshRef = useRef<Map<string, { requestedAt: number; localRevision: number }>>(new Map());
  const pendingConnectTailRefreshRef = useRef<Set<string>>(new Set());
  const pendingResumeTailRefreshRef = useRef<Set<string>>(new Set());
  const lastHeadRequestAtRef = useRef<Map<string, number>>(new Map());
  const sessionPullStateRef = useRef<Map<string, SessionPullStates>>(new Map());
  const sessionAttachTokensRef = useRef<Map<string, string>>(new Map());
  const pendingSessionTransportOpenIntentsRef = useRef<Map<string, PendingSessionTransportOpenIntent>>(new Map());
  const remoteScreenshotRuntimeRef = useRef(createRemoteScreenshotRuntime());
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
  const flushPendingInputQueueRef = useRef<((sessionId: string) => void) | null>(null);
  const handleSocketServerMessageRef = useRef<HandleSocketServerMessageFn | null>(null);

  return {
    sessionStore,
    scheduleStates,
    setScheduleStates,
    refs: {
      sessionDebugMetricsStoreRef,
      transportRuntimeStoreRef,
      sessionBufferStoreRef,
      sessionHeadStoreRef,
      pingIntervalsRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastPongAtRef,
      lastServerActivityAtRef,
      staleTransportProbeAtRef,
      viewportSizeRef,
      reconnectRuntimesRef,
      manualCloseRef,
      pendingInputQueueRef,
      lastActivatedSessionIdRef,
      sessionBufferHeadsRef,
      sessionRevisionResetRef,
      pendingInputTailRefreshRef,
      pendingConnectTailRefreshRef,
      pendingResumeTailRefreshRef,
      lastHeadRequestAtRef,
      sessionPullStateRef,
      sessionAttachTokensRef,
      pendingSessionTransportOpenIntentsRef,
      remoteScreenshotRuntimeRef,
      fileTransferMessageRuntimeRef,
      foregroundActiveRef,
      handleSocketConnectedBaselineRef,
      finalizeSocketFailureBaselineRef,
      flushPendingInputQueueRef,
      handleSocketServerMessageRef,
    },
  };
}
