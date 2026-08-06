import React, { useEffect, useRef, useState } from 'react';
import type { SessionScheduleState } from '../lib/types';
import { createFileTransferMessageRuntime } from '../lib/file-transfer-message-runtime';
import { createRemoteScreenshotRuntime } from '../lib/remote-screenshot-runtime';
import { createRemoteWindowMessageRuntime } from '../lib/remote-window-message-runtime';
import { createRemoteWindowReceiverRuntime } from '../lib/remote-window-receiver-runtime';
import { createSessionDebugMetricsStore } from '../lib/session-debug-metrics-store';
import { createSessionHeartbeatStore } from '../lib/session-heartbeat-store';
import { createSessionReconnectStore } from '../lib/session-reconnect-store';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { createSessionTransportRuntimeStore } from '../lib/session-transport-runtime';
import { createSessionTargetNetworkProbeRuntime } from './session-context-target-network-probe-runtime';
import { createSessionBufferStore } from '../lib/session-buffer-store';
import { createSessionRenderGate } from '../lib/session-render-gate';
import { createSessionHeadStore } from '../lib/session-head-store';
import { runtimeDebug } from '../lib/runtime-debug';
import type { PendingSessionTransportOpenIntent } from './session-transport-open-helpers';
import type { SessionTmuxTargetRequestStore } from './session-context-tmux-management-runtime';
import type { SessionVisibleRangeState } from './session-visible-range-helpers';
import type { SessionPullStates } from './session-pull-state-helpers';
import type { RevisionResetExpectation } from './session-context-core';
import type { BufferFrameAssemblyResourceState } from './session-context-buffer-runtime';
import type {
  FinalizeSocketFailureBaselineFn,
  HandleSocketConnectedBaselineFn,
  HandleSocketServerMessageFn,
} from './session-context-provider-assembly-types';
import type { RemoteWindowTargetCatalogCacheStore } from './session-context-remote-window-runtime';
import { createSessionAttachmentStore } from '../lib/session-attachment-store';
import { createSessionAttachmentFetchRuntime } from '../lib/session-attachment-fetch-runtime';
import type { SessionAttachmentStore } from '../lib/session-attachment-store';
import type { SessionAttachmentFetchRuntime } from '../lib/session-attachment-fetch-runtime';

export function useSessionProviderRuntime(options: {
  appForegroundActive?: boolean;
  foregroundResumeEpoch?: number;
  bridgeSettings?: import('@zterm/shared').BridgeSettings;
  wsUrl?: string;
}) {
  const { bridgeSettings, wsUrl } = options;

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
  const targetNetworkProbeRuntimeRef = useRef(createSessionTargetNetworkProbeRuntime({
    probeTimeoutMs: 2_500,
    now: Date.now,
  }));
  const handshakeTimeoutsRef = useRef<Map<string, number>>(new Map());
  const sessionVisibleRangeRef = useRef<Map<string, SessionVisibleRangeState>>(new Map());
  const lastActivatedSessionIdRef = useRef<string | null>(null);
  const lastActiveReentryAtRef = useRef<Map<string, number>>(new Map());
  const lastConnectedBaselineAtRef = useRef<Map<string, number>>(new Map());
  const lastBackgroundEnteredAtRef = useRef<Map<string, number>>(new Map());
  const connectedBaselineBurstGuardRef = useRef<Set<string>>(new Set());
  const sessionRevisionResetRef = useRef<Map<string, RevisionResetExpectation>>(new Map());
  const sessionTailRefreshStoreRef = useRef(createSessionTailRefreshStore());
  const lastHeadRequestAtRef = useRef<Map<string, number>>(new Map());
  const bufferFrameAssemblyRef = useRef<Map<string, BufferFrameAssemblyResourceState>>(new Map());
  const sessionPullStateRef = useRef<Map<string, SessionPullStates>>(new Map());
  const sessionAttachTokensRef = useRef<Map<string, string>>(new Map());
  const pendingSessionTransportOpenIntentsRef = useRef<Map<string, PendingSessionTransportOpenIntent>>(new Map());
  const tmuxTargetRequestsRef = useRef<SessionTmuxTargetRequestStore>(new Map());
  const activeBodySubscriptionSuppressedRef = useRef(false);
  const remoteScreenshotRuntimeRef = useRef(createRemoteScreenshotRuntime());
  const remoteWindowTargetCatalogCacheRef = useRef<RemoteWindowTargetCatalogCacheStore>(new Map());
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

  // Derive deviceId and base URL from settings
  const deviceId = bridgeSettings?.traversalRelay?.deviceId?.trim() || '';
  const daemonBaseUrl = wsUrl?.replace(/\/ws\/client$/, '') || '';
  const authToken = bridgeSettings?.traversalRelay?.accessToken || '';

  // Build HTTP fetch function for daemon attachment API
  const fetchDaemonHttpAsset = React.useCallback(
    async (attachmentId: string, asset: 'preview' | 'original'): Promise<{ blob: Blob; sha256: string }> => {
      if (!daemonBaseUrl) {
        throw new Error('daemon base URL not available');
      }
      const url = `${daemonBaseUrl}/attachment/${attachmentId}/${asset}`;
      const response = await fetch(url, {
        headers: {
          ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
        },
      });
      if (!response.ok) {
        throw new Error(`fetch failed: ${response.status} ${response.statusText}`);
      }
      const blob = await response.blob();
      // Compute SHA-256 for acknowledgment
      const arrayBuffer = await blob.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', arrayBuffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const sha256 = hashArray.map((b: number) => b.toString(16).padStart(2, '0')).join('');
      return { blob, sha256 };
    },
    [daemonBaseUrl, authToken],
  );

  const attachmentStoreRef = useRef<SessionAttachmentStore>(createSessionAttachmentStore());
  const attachmentFetchRuntimeRef = useRef<SessionAttachmentFetchRuntime>(createSessionAttachmentFetchRuntime({
    attachmentStore: attachmentStoreRef.current,
    deviceId,
    fetchDaemonHttpAsset,
    acknowledgeAsset: async () => {},
  }));
  const handleSocketServerMessageRef = useRef<HandleSocketServerMessageFn | null>(null);

  useEffect(() => () => {
    targetNetworkProbeRuntimeRef.current.dispose();
  }, []);

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
      targetNetworkProbeRuntimeRef,
      handshakeTimeoutsRef,
      sessionVisibleRangeRef,
      lastActivatedSessionIdRef,
      lastActiveReentryAtRef,
      lastConnectedBaselineAtRef,
      lastBackgroundEnteredAtRef,
      connectedBaselineBurstGuardRef,
      sessionRevisionResetRef,
      sessionTailRefreshStoreRef,
      lastHeadRequestAtRef,
      bufferFrameAssemblyRef,
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
      attachmentStoreRef,
      attachmentFetchRuntimeRef,
    },
  };
}
