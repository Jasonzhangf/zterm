import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { shouldResumeForeground } from '@zterm/shared/terminal/foreground-resume';
import { SESSION_STATUS_EVENT } from '../contexts/SessionContext';
import { createForegroundRefreshRuntime, markForegroundRuntimeHidden } from '../lib/app-foreground-refresh';
import { runtimeDebug } from '../lib/runtime-debug';
import {
  startBackgroundService,
  stopBackgroundService,
  updateSessionCount,
  setBackgroundHeartbeatCallback,
  recordBackgroundHeartbeat,
} from '../plugins/BackgroundServicePlugin';
import type { Session } from '../lib/types';
import { projectNetworkIdentitySnapshotError, type NetworkIdentityRuntime } from '../lib/network-identity';
import type {
  SessionTargetNetworkProbeFailure,
  SessionTargetNetworkSignal,
} from '../contexts/session-context-target-network-probe-runtime';

export type OpenTabAuditReason =
  | 'visibilitychange'
  | 'resume'
  | 'network-status-change'
  | 'appStateChange'
  | 'online'
  | 'connect'
  | 'session-picker-refresh'
  | 'drawer-open'
  | 'connections-page-open'
  | 'session-status-closed';

type ForegroundResumeReason = Extract<OpenTabAuditReason, 'visibilitychange' | 'resume' | 'appStateChange' | 'online'>;
type ForegroundResumeSignalReason = Exclude<ForegroundResumeReason, 'online'>;
export const BACKGROUND_HANDOFF_WAKE_LOCK_MS = 5 * 60 * 1000;

interface UseOpenTabLifecycleEffectsOptions {
  sessionsRef: MutableRefObject<Session[]>;
  openTabStateRef: MutableRefObject<{
    tabs: any[];
    activeSessionId: string | null;
  }>;
  foregroundRefreshRuntimeRef: MutableRefObject<ReturnType<typeof createForegroundRefreshRuntime>>;
  retainedSessionCount: number;
  onForegroundActiveChange?: (active: boolean) => void;
  onForegroundResume?: (reason: ForegroundResumeSignalReason) => void;
  lastBackgroundEnteredAtRef?: MutableRefObject<Map<string, number>>;
  /** SessionProvider facade: records background entry time into the session
   *  context's own ref so the resume grace decision reads the same instance. */
  recordBackgroundEnteredAt?: (sessionIds: string[], at: number) => void;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
  notifyTargetNetworkSignal: (
    signal: SessionTargetNetworkSignal,
  ) => void;
  reportTargetNetworkProbeError: (failure: SessionTargetNetworkProbeFailure) => void;
  bumpFollowResetEpoch: () => void;
  /** Client network-generation owner. When present, platform network events and
   *  foreground resume are stamped with generation/fingerprint changes so the
   *  transport owner can retire stale physical transports immediately. */
  networkIdentity?: NetworkIdentityRuntime;
  /** 后台心跳发送接口 */
  sendBackgroundHeartbeat?: () => void;
}

export function useBackgroundLiveSessionHandoff(options: {
  appForegroundActive: boolean;
  liveSessionIds?: string[];
  setActiveBodySubscriptionSuppressed: (suppressed: boolean) => void;
  setLiveSessionIds: (sessionIds: string[]) => void;
}) {
  const {
    appForegroundActive,
    liveSessionIds,
    setActiveBodySubscriptionSuppressed,
    setLiveSessionIds,
  } = options;
  const liveSessionClearTimerRef = useRef<number | null>(null);
  const latestLiveSessionIdsRef = useRef<string[]>([]);
  const clearedLiveSessionIdsRef = useRef<string[] | null>(null);

  useEffect(() => {
    latestLiveSessionIdsRef.current = (liveSessionIds || []).filter(Boolean);
  }, [liveSessionIds]);

  useEffect(() => {
    const clearLiveSessionTimer = () => {
      if (liveSessionClearTimerRef.current === null) {
        return;
      }
      window.clearTimeout(liveSessionClearTimerRef.current);
      liveSessionClearTimerRef.current = null;
    };
    clearLiveSessionTimer();
    if (appForegroundActive === false) {
      setActiveBodySubscriptionSuppressed(true);
      liveSessionClearTimerRef.current = window.setTimeout(() => {
        liveSessionClearTimerRef.current = null;
        clearedLiveSessionIdsRef.current = latestLiveSessionIdsRef.current;
        setLiveSessionIds([]);
      }, BACKGROUND_HANDOFF_WAKE_LOCK_MS);
      return clearLiveSessionTimer;
    }
    setActiveBodySubscriptionSuppressed(false);
    if (clearedLiveSessionIdsRef.current && clearedLiveSessionIdsRef.current.length > 0) {
      setLiveSessionIds(clearedLiveSessionIdsRef.current);
    }
    clearedLiveSessionIdsRef.current = null;
    return clearLiveSessionTimer;
  }, [appForegroundActive, setActiveBodySubscriptionSuppressed, setLiveSessionIds]);
}

export function useOpenTabLifecycleEffects(options: UseOpenTabLifecycleEffectsOptions) {
  const {
    sessionsRef,
    openTabStateRef,
    foregroundRefreshRuntimeRef,
    retainedSessionCount,
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    notifyTargetNetworkSignal,
    reportTargetNetworkProbeError,
    bumpFollowResetEpoch,
    networkIdentity,
  } = options;

  const callbacksRef = useRef({
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    notifyTargetNetworkSignal,
    reportTargetNetworkProbeError,
    bumpFollowResetEpoch,
    networkIdentity,
  });
  callbacksRef.current = {
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    notifyTargetNetworkSignal,
    reportTargetNetworkProbeError,
    bumpFollowResetEpoch,
    networkIdentity,
  };
  const nativeBackgroundServiceRunningRef = useRef(false);
  // Foreground-resume path: re-read the platform status + local interfaces so a
  // network change that happened while hidden (and whose event was dropped) is
  // recovered as a generation change. The immediate same-generation signal is
  // sent first so the existing conservative probe still runs; if the resample
  // observes a real fingerprint change, a follow-up cross-generation signal
  // retires every stale physical transport right away.
  const refreshNetworkIdentityForForeground = useCallback(async () => {
    const runtime = callbacksRef.current.networkIdentity;
    if (!runtime) {
      return;
    }
    let connected = true;
    let connectionType = 'unknown';
    try {
      const status = await Network.getStatus();
      connected = status.connected;
      connectionType = status.connectionType;
    } catch {
      // Web/unit environments may not expose getStatus(); fall back to the
      // cached fingerprint and let resample still compare interface truth.
    }
    let sample;
    try {
      sample = await runtime.resampleWithStatus({ connected, connectionType });
    } catch (error: unknown) {
      const snapshotError = projectNetworkIdentitySnapshotError(error);
      const reportTargetNetworkProbeError = callbacksRef.current.reportTargetNetworkProbeError;
      if (reportTargetNetworkProbeError) {
        reportTargetNetworkProbeError({
          type: 'TargetNetworkProbeError04NativeSnapshot',
          message: snapshotError.message,
        });
        return;
      }
      runtimeDebug('app.network.identity.native-snapshot-error-owner-missing', {
        message: snapshotError.message,
      });
      return;
    }
    if (sample.fingerprintChanged) {
      callbacksRef.current.notifyTargetNetworkSignal({
        source: 'foreground-resume',
        networkGeneration: sample.generation,
        fingerprintChanged: true,
      });
      runtimeDebug('app.network.identity.generation-changed', {
        source: 'foreground-resume',
        networkGeneration: sample.generation,
      });
    }
  }, []);
  const maybeProjectForegroundResume = useCallback((reason: ForegroundResumeSignalReason) => {
    const now = Date.now();
    const runtime = callbacksRef.current.networkIdentity;
    callbacksRef.current.notifyTargetNetworkSignal({
      source: 'foreground-resume',
      ...(runtime ? {
        networkGeneration: runtime.readGeneration(),
        fingerprintChanged: false,
      } : {}),
    });
    void refreshNetworkIdentityForForeground();
    const hasSessions = sessionsRef.current.length > 0;
    const hasActiveSession = Boolean(openTabStateRef.current.activeSessionId);
    const wasHiddenForDecision = (
      foregroundRefreshRuntimeRef.current.wasHidden
      || reason === 'resume'
      || reason === 'appStateChange'
    );
    const decision = shouldResumeForeground(
      now,
      foregroundRefreshRuntimeRef.current.lastResumeAt,
      800,
      wasHiddenForDecision,
      hasSessions,
      hasActiveSession,
    );
    foregroundRefreshRuntimeRef.current.wasHidden = false;
    if (!decision.shouldResume) {
      runtimeDebug('app.foreground.resume.skip', {
        reason,
        skipReason: decision.skipReason || null,
        lastResumeAt: foregroundRefreshRuntimeRef.current.lastResumeAt,
        wasHidden: foregroundRefreshRuntimeRef.current.wasHidden,
        hasSessions,
        hasActiveSession,
      });
      return;
    }
    foregroundRefreshRuntimeRef.current.lastResumeAt = now;
    callbacksRef.current.onForegroundResume?.(reason);
    callbacksRef.current.bumpFollowResetEpoch();
    void callbacksRef.current.auditOpenTabsAgainstRemoteSessions(reason).catch((error) => {
      console.error('[App] Failed to audit remote session truth on foreground resume:', error);
    });
  }, [foregroundRefreshRuntimeRef, openTabStateRef, sessionsRef, refreshNetworkIdentityForForeground]);

  useEffect(() => {
    let foregroundProjectionActive = true;

    const projectForegroundActive = (active: boolean) => {
      if (foregroundProjectionActive === active) {
        return;
      }
      foregroundProjectionActive = active;
      callbacksRef.current.onForegroundActiveChange?.(active);
    };

    const countRetainedSessions = () => (
      sessionsRef.current.filter((session) => session.state !== 'closed').length
    );

    /**
     * 后台心跳回调 - 定期发送 ping 保持连接活跃
     */
    const sendBackgroundHeartbeat = () => {
      if (!options.sendBackgroundHeartbeat) {
        return;
      }
      options.sendBackgroundHeartbeat();
      recordBackgroundHeartbeat();
      runtimeDebug('app.background.heartbeat.sent', {});
    };
    const startNativeBackgroundService = () => {
      const sessionCount = countRetainedSessions();
      if (sessionCount <= 0) {
        if (nativeBackgroundServiceRunningRef.current) {
          stopBackgroundService();
          setBackgroundHeartbeatCallback(null);
          nativeBackgroundServiceRunningRef.current = false;
        }
        return;
      }
      if (nativeBackgroundServiceRunningRef.current) {
        updateSessionCount(sessionCount);
        return;
      }
      nativeBackgroundServiceRunningRef.current = true;
      startBackgroundService(sessionCount);

      runtimeDebug('app.background.service.start', {
        sessionCount,
        handoffWakeLockMs: BACKGROUND_HANDOFF_WAKE_LOCK_MS,
        lifecycleOwner: 'retained-session-count',
      });
    };

    const enableBackgroundHeartbeat = () => {
      setBackgroundHeartbeatCallback(sendBackgroundHeartbeat);
    };

    const disableBackgroundHeartbeat = () => {
      setBackgroundHeartbeatCallback(null);
    };

    const markHidden = () => {
      markForegroundRuntimeHidden(foregroundRefreshRuntimeRef.current, document.visibilityState);
      projectForegroundActive(false);
      // Record background entry time for all active sessions. Prefer the
      // SessionProvider-owned facade so the resume grace decision reads the
      // same map instance; fall back to the local ref for tests that render
      // the lifecycle hook without a SessionProvider.
      if (options.recordBackgroundEnteredAt) {
        const now = Date.now();
        options.recordBackgroundEnteredAt(
          options.sessionsRef.current.map((session) => session.id),
          now,
        );
      } else if (options.lastBackgroundEnteredAtRef) {
        const now = Date.now();
        for (const session of options.sessionsRef.current) {
          options.lastBackgroundEnteredAtRef.current.set(session.id, now);
        }
      }
      startNativeBackgroundService();
      enableBackgroundHeartbeat();
    };

    const onVisibilityChange = () => {
      runtimeDebug('app.visibility.change', {
        visibilityState: document.visibilityState,
        wasHidden: foregroundRefreshRuntimeRef.current.wasHidden,
      });
      if (document.visibilityState === 'hidden') {
        markHidden();
        return;
      }

      if (document.visibilityState === 'visible' && foregroundRefreshRuntimeRef.current.wasHidden) {
        projectForegroundActive(true);
        disableBackgroundHeartbeat();
        maybeProjectForegroundResume('visibilitychange');
      }
    };

    const onDocumentResume = () => {
      projectForegroundActive(true);
      disableBackgroundHeartbeat();
      runtimeDebug('app.document.resume', {});
      maybeProjectForegroundResume('resume');
    };

    const onNetworkOnline = () => {
      if (document.visibilityState === 'hidden') {
        runtimeDebug('app.network.online.hidden', {});
        return;
      }
      runtimeDebug('app.network.online', {});
      const runtime = callbacksRef.current.networkIdentity;
      const sample = runtime
        ? runtime.ingestNetworkStatus({ connected: true, connectionType: 'unknown' })
        : null;
      callbacksRef.current.notifyTargetNetworkSignal({
        connected: true,
        connectionType: 'unknown',
        source: 'window-online',
        ...(sample ? { networkGeneration: sample.generation, fingerprintChanged: sample.fingerprintChanged } : {}),
      });
    };

    const capacitorNetworkListenerHandle = Network.addListener('networkStatusChange', (status) => {
      runtimeDebug('app.capacitor.networkStatusChange', {
        connected: status.connected,
        connectionType: status.connectionType,
      });
      if (document.visibilityState === 'hidden') {
        runtimeDebug('app.capacitor.networkStatusChange.hidden', {
          connected: status.connected,
          connectionType: status.connectionType,
        });
        return;
      }
      const runtime = callbacksRef.current.networkIdentity;
      const sample = runtime
        ? runtime.ingestNetworkStatus({ connected: status.connected, connectionType: status.connectionType })
        : null;
      callbacksRef.current.notifyTargetNetworkSignal({
        connected: status.connected,
        connectionType: status.connectionType,
        source: 'capacitor',
        ...(sample ? { networkGeneration: sample.generation, fingerprintChanged: sample.fingerprintChanged } : {}),
      });
    });

    const appStateListenerHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      runtimeDebug('app.capacitor.appStateChange', {
        isActive,
        wasHidden: foregroundRefreshRuntimeRef.current.wasHidden,
      });
      if (!isActive) {
        markHidden();
        return;
      }
      projectForegroundActive(true);
      disableBackgroundHeartbeat();
      maybeProjectForegroundResume('appStateChange');
    });

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', onDocumentResume as EventListener);
    document.addEventListener('pause', markHidden as EventListener);
    window.addEventListener('online', onNetworkOnline);

    return () => {
      void Promise.resolve(appStateListenerHandle)
        .then((listener) => listener?.remove?.())
        .catch((error) => {
          console.warn('[App] Failed to remove app state listener:', error);
        });
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('resume', onDocumentResume as EventListener);
      document.removeEventListener('pause', markHidden as EventListener);
      window.removeEventListener('online', onNetworkOnline);
      void Promise.resolve(capacitorNetworkListenerHandle)
        .then((listener) => listener?.remove?.())
        .catch((error) => {
          console.warn('[App] Failed to remove capacitor network listener:', error);
        });
    };
  }, [
    foregroundRefreshRuntimeRef,
    maybeProjectForegroundResume,
    openTabStateRef,
  ]);

  useEffect(() => () => {
    if (!nativeBackgroundServiceRunningRef.current) {
      return;
    }
    nativeBackgroundServiceRunningRef.current = false;
    setBackgroundHeartbeatCallback(null);
    stopBackgroundService();
    runtimeDebug('app.background.service.stop.lifecycle-dispose', {});
  }, []);

  useEffect(() => {
    if (retainedSessionCount <= 0) {
      if (nativeBackgroundServiceRunningRef.current) {
        nativeBackgroundServiceRunningRef.current = false;
        setBackgroundHeartbeatCallback(null);
        stopBackgroundService();
        runtimeDebug('app.background.service.stop.empty', {});
      }
      return;
    }
    if (!nativeBackgroundServiceRunningRef.current) {
      nativeBackgroundServiceRunningRef.current = true;
      startBackgroundService(retainedSessionCount);
      runtimeDebug('app.background.service.start.retained', {
        sessionCount: retainedSessionCount,
      });
      return;
    }
    updateSessionCount(retainedSessionCount);
    runtimeDebug('app.background.service.update', {
      sessionCount: retainedSessionCount,
    });
  }, [retainedSessionCount, options.sendBackgroundHeartbeat]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const onSessionStatus = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string; type?: 'closed' | 'error'; message?: string }>).detail;
      const sessionId = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : '';
      if (!sessionId) {
        return;
      }
      runtimeDebug('app.session.status', {
        sessionId,
        type: detail?.type || 'unknown',
        message: detail?.message || null,
        activeSessionId: openTabStateRef.current.activeSessionId,
        sessions: sessionsRef.current.map((session) => ({
          id: session.id,
          state: session.state,
          title: session.title,
        })),
      });
      if (detail?.type === 'closed') {
        void callbacksRef.current.auditOpenTabsAgainstRemoteSessions('session-status-closed').catch((error) => {
          console.error('[App] Failed to audit remote session truth after session-status closed:', error);
        });
      }
    };

    window.addEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    return () => {
      window.removeEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    };
  }, [sessionsRef]);
}
