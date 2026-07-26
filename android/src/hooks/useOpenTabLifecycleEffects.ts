import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { shouldResumeForeground } from '@zterm/shared/terminal/foreground-resume';
import { SESSION_STATUS_EVENT } from '../contexts/SessionContext';
import { createForegroundRefreshRuntime, markForegroundRuntimeHidden } from '../lib/app-foreground-refresh';
import { runtimeDebug } from '../lib/runtime-debug';
import type { Session } from '../lib/types';

export type OpenTabAuditReason =
  | 'visibilitychange'
  | 'resume'
  | 'appStateChange'
  | 'online'
  | 'connect'
  | 'session-picker-refresh'
  | 'connections-page-open'
  | 'session-status-closed';

type ForegroundResumeReason = Extract<OpenTabAuditReason, 'visibilitychange' | 'resume' | 'appStateChange' | 'online'>;
type ForegroundResumeSignalReason = Exclude<ForegroundResumeReason, 'online'>;

interface UseOpenTabLifecycleEffectsOptions {
  sessionsRef: MutableRefObject<Session[]>;
  openTabStateRef: MutableRefObject<{
    tabs: any[];
    activeSessionId: string | null;
  }>;
  foregroundRefreshRuntimeRef: MutableRefObject<ReturnType<typeof createForegroundRefreshRuntime>>;
  onForegroundActiveChange?: (active: boolean) => void;
  onForegroundResume?: (reason: ForegroundResumeSignalReason) => void;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
  resumeActiveSessionTransport: (sessionId: string) => boolean;
  bumpFollowResetEpoch: () => void;
}

export function useOpenTabLifecycleEffects(options: UseOpenTabLifecycleEffectsOptions) {
  const {
    sessionsRef,
    openTabStateRef,
    foregroundRefreshRuntimeRef,
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    resumeActiveSessionTransport,
    bumpFollowResetEpoch,
  } = options;

  const callbacksRef = useRef({
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    resumeActiveSessionTransport,
    bumpFollowResetEpoch,
  });
  callbacksRef.current = {
    onForegroundActiveChange,
    onForegroundResume,
    auditOpenTabsAgainstRemoteSessions,
    resumeActiveSessionTransport,
    bumpFollowResetEpoch,
  };

  const maybeProjectForegroundResume = useCallback((reason: ForegroundResumeSignalReason) => {
    const now = Date.now();
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
    const markHidden = () => {
      callbacksRef.current.onForegroundActiveChange?.(false);
      markForegroundRuntimeHidden(foregroundRefreshRuntimeRef.current, document.visibilityState);
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
        callbacksRef.current.onForegroundActiveChange?.(true);
        maybeProjectForegroundResume('visibilitychange');
      }
    };

    const onDocumentResume = () => {
      callbacksRef.current.onForegroundActiveChange?.(true);
      runtimeDebug('app.document.resume', {});
      maybeProjectForegroundResume('resume');
    };

    const onNetworkOnline = () => {
      if (document.visibilityState === 'hidden') {
        runtimeDebug('app.network.online.hidden', {});
        return;
      }
      callbacksRef.current.onForegroundActiveChange?.(true);
      runtimeDebug('app.network.online', {});
      const activeSessionId = openTabStateRef.current.activeSessionId;
      if (activeSessionId) {
        callbacksRef.current.resumeActiveSessionTransport(activeSessionId);
      }
      foregroundRefreshRuntimeRef.current.wasHidden = false;
      void callbacksRef.current.auditOpenTabsAgainstRemoteSessions('online').catch((error) => {
        console.error('[App] Failed to audit remote session truth on online recovery:', error);
      });
    };

    const appStateListenerHandle = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      runtimeDebug('app.capacitor.appStateChange', {
        isActive,
        wasHidden: foregroundRefreshRuntimeRef.current.wasHidden,
      });
      if (!isActive) {
        markHidden();
        return;
      }
      callbacksRef.current.onForegroundActiveChange?.(true);
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
    };
  }, [
    foregroundRefreshRuntimeRef,
    maybeProjectForegroundResume,
    openTabStateRef,
  ]);

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
