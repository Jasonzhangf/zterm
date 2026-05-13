import { useCallback, type MutableRefObject } from 'react';
import {
  activateOpenTabIntentSession,
  moveOpenTabIntentSession,
  renameOpenTabIntentSession,
} from '../lib/open-tab-intent';
import { runtimeDebug } from '../lib/runtime-debug';
import type { OpenTabRuntimeSwitchReason } from '../lib/open-tab-runtime-switch';
import type { Session, PersistedOpenTab } from '../lib/types';

interface ApplyOpenTabStateFn {
  (
    nextState: {
      tabs: PersistedOpenTab[];
      activeSessionId: string | null;
    },
    options?: { fallbackActiveSessionId?: string | null; switchRuntime?: OpenTabRuntimeSwitchReason },
  ): {
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  };
}

interface UseOpenTabSessionActionsOptions {
  openTabStateRef: MutableRefObject<{
    tabs: PersistedOpenTab[];
    activeSessionId: string | null;
  }>;
  sessionsRef: MutableRefObject<Session[]>;
  runtimeActiveSessionIdRef: MutableRefObject<string | null>;
  applyOpenTabState: ApplyOpenTabStateFn;
  ensureTerminalPageVisible: () => void;
  moveSession: (sessionId: string, toIndex: number) => void;
  renameSession: (sessionId: string, name: string) => void;
  applyClosedOpenTabIntent: (sessionId: string, closeOptions?: {
    runtimeActiveSessionId?: string | null;
    fallbackSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'>>;
    closeRuntimeSession?: boolean;
    clearDraft?: boolean;
    source?: string;
  }) => unknown;
  openExplicitSessionById: (sessionId: string) => boolean;
}

export function useOpenTabSessionActions(options: UseOpenTabSessionActionsOptions) {
  const {
    openTabStateRef,
    sessionsRef,
    runtimeActiveSessionIdRef,
    applyOpenTabState,
    ensureTerminalPageVisible,
    moveSession,
    renameSession,
    applyClosedOpenTabIntent,
    openExplicitSessionById,
  } = options;

  const handleSwitchSession = useCallback((sessionId: string) => {
    const nextOpenTabState = activateOpenTabIntentSession(openTabStateRef.current, sessionId);
    applyOpenTabState(nextOpenTabState, {
      switchRuntime: 'explicit-resume',
    });
    ensureTerminalPageVisible();
  }, [
    applyOpenTabState,
    ensureTerminalPageVisible,
    openTabStateRef,
  ]);

  const handleMoveSession = useCallback((sessionId: string, toIndex: number) => {
    const nextOpenTabState = moveOpenTabIntentSession(openTabStateRef.current, sessionId, toIndex);
    applyOpenTabState(nextOpenTabState, {
      fallbackActiveSessionId: openTabStateRef.current.activeSessionId,
    });
    moveSession(sessionId, toIndex);
  }, [
    applyOpenTabState,
    moveSession,
    openTabStateRef,
  ]);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    const nextOpenTabState = renameOpenTabIntentSession(openTabStateRef.current, sessionId, name);
    applyOpenTabState(nextOpenTabState, {
      fallbackActiveSessionId: openTabStateRef.current.activeSessionId,
    });
    renameSession(sessionId, name);
  }, [
    applyOpenTabState,
    openTabStateRef,
    renameSession,
  ]);

  const handleCloseSession = useCallback((sessionId: string, source = 'unknown') => {
    const runtimeSessions = sessionsRef.current;
    const currentRuntimeActiveSessionId = runtimeActiveSessionIdRef.current;
    runtimeDebug('app.session.close.request', {
      sessionId,
      source,
      activeSessionId: currentRuntimeActiveSessionId,
      sessions: runtimeSessions.map((session) => ({ id: session.id, state: session.state, title: session.title })),
    });
    console.warn('[App] close session request', {
      sessionId,
      source,
      activeSessionId: currentRuntimeActiveSessionId,
      sessionCount: runtimeSessions.length,
    });

    applyClosedOpenTabIntent(sessionId, {
      runtimeSessions,
      runtimeActiveSessionId: currentRuntimeActiveSessionId,
      fallbackSessionIds: runtimeSessions.filter((session) => session.id !== sessionId).map((session) => session.id),
      closeRuntimeSession: true,
      clearDraft: true,
      source,
    });
  }, [applyClosedOpenTabIntent, runtimeActiveSessionIdRef, sessionsRef]);

  const handleResumeSession = useCallback((sessionId: string) => {
    if (openExplicitSessionById(sessionId)) {
      return;
    }
    handleSwitchSession(sessionId);
  }, [handleSwitchSession, openExplicitSessionById]);

  return {
    handleSwitchSession,
    handleMoveSession,
    handleRenameSession,
    handleCloseSession,
    handleResumeSession,
  };
}
