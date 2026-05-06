import { useEffect, type MutableRefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { SESSION_STATUS_EVENT } from '../contexts/SessionContext';
import { createForegroundRefreshRuntime, markForegroundRuntimeHidden, performForegroundRefresh } from '../lib/app-foreground-refresh';
import { runtimeDebug } from '../lib/runtime-debug';
import type { Session } from '../lib/types';

export type OpenTabAuditReason =
  | 'visibilitychange'
  | 'resume'
  | 'appStateChange';

interface OpenTabLifecycleCloseOptions {
  runtimeActiveSessionId?: string | null;
  fallbackSessionIds?: string[];
  runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken'>>;
  closeRuntimeSession?: boolean;
  clearDraft?: boolean;
  source?: string;
}

interface UseOpenTabLifecycleEffectsOptions {
  sessionsRef: MutableRefObject<Session[]>;
  activeSessionIdRef: MutableRefObject<string | null>;
  resumeActiveSessionTransportRef: MutableRefObject<(sessionId: string) => boolean>;
  foregroundRefreshRuntimeRef: MutableRefObject<ReturnType<typeof createForegroundRefreshRuntime>>;
  onForegroundActiveChange?: (active: boolean) => void;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
  applyClosedOpenTabIntent: (sessionId: string, closeOptions?: OpenTabLifecycleCloseOptions) => unknown;
  bumpFollowResetEpoch: () => void;
}

export function useOpenTabLifecycleEffects(options: UseOpenTabLifecycleEffectsOptions) {
  const {
    sessionsRef,
    activeSessionIdRef,
    resumeActiveSessionTransportRef,
    foregroundRefreshRuntimeRef,
    onForegroundActiveChange,
    auditOpenTabsAgainstRemoteSessions,
    applyClosedOpenTabIntent,
    bumpFollowResetEpoch,
  } = options;

  useEffect(() => {
    const notifyResume = (reason: Exclude<OpenTabAuditReason, 'foreground-poll'>) => {
      bumpFollowResetEpoch();
      performForegroundRefresh({
        reason,
        sessions: sessionsRef.current.map((session) => ({ id: session.id, state: session.state })),
        activeSessionId: activeSessionIdRef.current,
        resumeActiveSessionTransport: resumeActiveSessionTransportRef.current,
        runtime: foregroundRefreshRuntimeRef.current,
        log: (entry) => {
          console.debug('[App] foreground resume actions ->', entry);
        },
      });
      void auditOpenTabsAgainstRemoteSessions(reason).catch((error) => {
        console.error('[App] Failed to audit remote session truth on foreground resume:', error);
      });
    };

    const markHidden = () => {
      onForegroundActiveChange?.(false);
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
        onForegroundActiveChange?.(true);
        foregroundRefreshRuntimeRef.current.wasHidden = false;
        notifyResume('visibilitychange');
      }
    };

    const onDocumentResume = () => {
      onForegroundActiveChange?.(true);
      foregroundRefreshRuntimeRef.current.wasHidden = false;
      runtimeDebug('app.document.resume', {});
      notifyResume('resume');
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
      onForegroundActiveChange?.(true);
      foregroundRefreshRuntimeRef.current.wasHidden = false;
      notifyResume('appStateChange');
    });

    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('resume', onDocumentResume as EventListener);
    document.addEventListener('pause', markHidden as EventListener);

    return () => {
      void Promise.resolve(appStateListenerHandle)
        .then((listener) => listener?.remove?.())
        .catch((error) => {
          console.warn('[App] Failed to remove app state listener:', error);
        });
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('resume', onDocumentResume as EventListener);
      document.removeEventListener('pause', markHidden as EventListener);
    };
  }, [
    activeSessionIdRef,
    auditOpenTabsAgainstRemoteSessions,
    bumpFollowResetEpoch,
    foregroundRefreshRuntimeRef,
    onForegroundActiveChange,
    resumeActiveSessionTransportRef,
    sessionsRef,
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
        activeSessionId: activeSessionIdRef.current,
        sessions: sessionsRef.current.map((session) => ({
          id: session.id,
          state: session.state,
          title: session.title,
        })),
      });
      if (detail?.type === 'closed') {
        applyClosedOpenTabIntent(sessionId, {
          runtimeSessions: sessionsRef.current,
          runtimeActiveSessionId: activeSessionIdRef.current,
          fallbackSessionIds: sessionsRef.current
            .filter((session) => session.id !== sessionId)
            .map((session) => session.id),
          closeRuntimeSession: true,
          clearDraft: true,
          source: 'session-status-closed',
        });
      }
    };

    window.addEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    return () => {
      window.removeEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    };
  }, [activeSessionIdRef, applyClosedOpenTabIntent, sessionsRef]);
}
