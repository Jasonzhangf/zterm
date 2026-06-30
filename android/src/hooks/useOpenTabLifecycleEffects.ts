import { useEffect, type MutableRefObject } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
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

interface UseOpenTabLifecycleEffectsOptions {
  sessionsRef: MutableRefObject<Session[]>;
  openTabStateRef: MutableRefObject<{
    tabs: any[];
    activeSessionId: string | null;
  }>;
  foregroundRefreshRuntimeRef: MutableRefObject<ReturnType<typeof createForegroundRefreshRuntime>>;
  onForegroundActiveChange?: (active: boolean) => void;
  auditOpenTabsAgainstRemoteSessions: (reason: OpenTabAuditReason) => Promise<void>;
  reconnectSession: (sessionId: string) => void;
  bumpFollowResetEpoch: () => void;
}

export function useOpenTabLifecycleEffects(options: UseOpenTabLifecycleEffectsOptions) {
  const {
    sessionsRef,
    openTabStateRef,
    foregroundRefreshRuntimeRef,
    onForegroundActiveChange,
    auditOpenTabsAgainstRemoteSessions,
    reconnectSession,
    bumpFollowResetEpoch,
  } = options;

  useEffect(() => {
    const notifyResume = (reason: ForegroundResumeReason) => {
      bumpFollowResetEpoch();
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

    const onNetworkOnline = () => {
      if (document.visibilityState === 'hidden') {
        runtimeDebug('app.network.online.hidden', {});
        return;
      }
      onForegroundActiveChange?.(true);
      foregroundRefreshRuntimeRef.current.wasHidden = false;
      runtimeDebug('app.network.online', {});
      const activeSessionId = openTabStateRef.current.activeSessionId;
      if (activeSessionId) {
        reconnectSession(activeSessionId);
      }
      notifyResume('online');
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
    auditOpenTabsAgainstRemoteSessions,
    bumpFollowResetEpoch,
    foregroundRefreshRuntimeRef,
    openTabStateRef,
    onForegroundActiveChange,
    reconnectSession,
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
        activeSessionId: openTabStateRef.current.activeSessionId,
        sessions: sessionsRef.current.map((session) => ({
          id: session.id,
          state: session.state,
          title: session.title,
        })),
      });
      if (detail?.type === 'closed') {
        void auditOpenTabsAgainstRemoteSessions('session-status-closed').catch((error) => {
          console.error('[App] Failed to audit remote session truth after session-status closed:', error);
        });
      }
    };

    window.addEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    return () => {
      window.removeEventListener(SESSION_STATUS_EVENT, onSessionStatus as EventListener);
    };
  }, [auditOpenTabsAgainstRemoteSessions, sessionsRef]);
}
