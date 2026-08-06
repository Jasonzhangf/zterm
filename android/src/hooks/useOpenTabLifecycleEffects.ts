import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Network } from '@capacitor/network';
import { shouldResumeForeground } from '@zterm/shared/terminal/foreground-resume';
import { SESSION_STATUS_EVENT } from '../contexts/SessionContext';
import { createForegroundRefreshRuntime, markForegroundRuntimeHidden } from '../lib/app-foreground-refresh';
import { runtimeDebug } from '../lib/runtime-debug';
import { startBackgroundService, stopBackgroundService, updateSessionCount } from '../plugins/BackgroundServicePlugin';
import type { Session } from '../lib/types';
import type { SessionTargetNetworkSignal } from '../contexts/session-context-target-network-probe-runtime';

export type OpenTabAuditReason =
  | 'visibilitychange'
  | 'resume'
  | 'network-status-change'
  | 'appStateChange'
  | 'online'
  | 'connect'
  | 'session-picker-refresh'
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
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
  notifyTargetNetworkSignal: (
    signal: SessionTargetNetworkSignal,
  ) => void;
  bumpFollowResetEpoch: () => void;
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
    bumpFollowResetEpoch,
  } = options;

  const callbacksRef = useRef({
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    notifyTargetNetworkSignal,
    bumpFollowResetEpoch,
  });
  callbacksRef.current = {
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    notifyTargetNetworkSignal,
    bumpFollowResetEpoch,
  };
  const nativeBackgroundServiceRunningRef = useRef(false);

  const maybeProjectForegroundResume = useCallback((reason: ForegroundResumeSignalReason) => {
    const now = Date.now();
    callbacksRef.current.notifyTargetNetworkSignal({
      source: 'foreground-resume',
    });
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
  }, [foregroundRefreshRuntimeRef, openTabStateRef, sessionsRef]);

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

    const startNativeBackgroundService = () => {
      const sessionCount = countRetainedSessions();
      if (sessionCount <= 0) {
        if (nativeBackgroundServiceRunningRef.current) {
          stopBackgroundService();
          nativeBackgroundServiceRunningRef.current = false;
        }
        return;
      }
      nativeBackgroundServiceRunningRef.current = true;
      startBackgroundService(sessionCount);
      runtimeDebug('app.background.service.start', {
        sessionCount,
        handoffWakeLockMs: BACKGROUND_HANDOFF_WAKE_LOCK_MS,
      });
    };

    const stopNativeBackgroundService = () => {
      if (!nativeBackgroundServiceRunningRef.current) {
        return;
      }
      nativeBackgroundServiceRunningRef.current = false;
      stopBackgroundService();
      runtimeDebug('app.background.service.stop', {});
    };

    const markHidden = () => {
      markForegroundRuntimeHidden(foregroundRefreshRuntimeRef.current, document.visibilityState);
      projectForegroundActive(false);
      // Record background entry time for all active sessions
      if (options.lastBackgroundEnteredAtRef) {
        const now = Date.now();
        for (const session of options.sessionsRef.current) {
          options.lastBackgroundEnteredAtRef.current.set(session.id, now);
        }
      }
      startNativeBackgroundService();
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
        stopNativeBackgroundService();
        projectForegroundActive(true);
        maybeProjectForegroundResume('visibilitychange');
      }
    };

    const onDocumentResume = () => {
      stopNativeBackgroundService();
      projectForegroundActive(true);
      runtimeDebug('app.document.resume', {});
      maybeProjectForegroundResume('resume');
    };

    const onNetworkOnline = () => {
      if (document.visibilityState === 'hidden') {
        runtimeDebug('app.network.online.hidden', {});
        return;
      }
      runtimeDebug('app.network.online', {});
      callbacksRef.current.notifyTargetNetworkSignal({
        connected: true,
        connectionType: 'unknown',
        source: 'window-online',
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
      callbacksRef.current.notifyTargetNetworkSignal({
        connected: status.connected,
        connectionType: status.connectionType,
        source: 'capacitor',
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
      stopNativeBackgroundService();
      projectForegroundActive(true);
      maybeProjectForegroundResume('appStateChange');
    });

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', onDocumentResume as EventListener);
    document.addEventListener('pause', markHidden as EventListener);
    window.addEventListener('online', onNetworkOnline);

    return () => {
      stopNativeBackgroundService();
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

  useEffect(() => {
    if (!nativeBackgroundServiceRunningRef.current) {
      return;
    }
    if (retainedSessionCount <= 0) {
      nativeBackgroundServiceRunningRef.current = false;
      stopBackgroundService();
      runtimeDebug('app.background.service.stop.empty', {});
      return;
    }
    updateSessionCount(retainedSessionCount);
    runtimeDebug('app.background.service.update', {
      sessionCount: retainedSessionCount,
    });
  }, [retainedSessionCount]);

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
