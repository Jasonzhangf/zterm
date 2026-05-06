import { useCallback, type MutableRefObject } from 'react';
import {
  activateOpenTabIntentSession,
  moveOpenTabIntentSession,
  renameOpenTabIntentSession,
} from '../lib/open-tab-intent';
import { runtimeDebug } from '../lib/runtime-debug';
import type { Session, PersistedOpenTab } from '../lib/types';

interface PersistOpenTabIntentStateFn {
  (
    nextState: {
      tabs: PersistedOpenTab[];
      activeSessionId: string | null;
    },
    options?: { fallbackActiveSessionId?: string | null },
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
  activeSessionIdRef: MutableRefObject<string | null>;
  persistOpenTabIntentState: PersistOpenTabIntentStateFn;
  requestRuntimeActiveSessionSwitch: (nextActiveSessionId: string | null) => void;
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
}

export function useOpenTabSessionActions(options: UseOpenTabSessionActionsOptions) {
  const {
    openTabStateRef,
    sessionsRef,
    activeSessionIdRef,
    persistOpenTabIntentState,
    requestRuntimeActiveSessionSwitch,
    ensureTerminalPageVisible,
    moveSession,
    renameSession,
    applyClosedOpenTabIntent,
  } = options;

  const handleSwitchSession = useCallback((sessionId: string) => {
    const nextOpenTabState = activateOpenTabIntentSession(openTabStateRef.current, sessionId);
    persistOpenTabIntentState(nextOpenTabState);
    requestRuntimeActiveSessionSwitch(nextOpenTabState.activeSessionId);
    ensureTerminalPageVisible();
  }, [
    ensureTerminalPageVisible,
    openTabStateRef,
    persistOpenTabIntentState,
    requestRuntimeActiveSessionSwitch,
  ]);

  const handleMoveSession = useCallback((sessionId: string, toIndex: number) => {
    const nextOpenTabState = moveOpenTabIntentSession(openTabStateRef.current, sessionId, toIndex);
    persistOpenTabIntentState(nextOpenTabState, {
      fallbackActiveSessionId: activeSessionIdRef.current,
    });
    moveSession(sessionId, toIndex);
  }, [
    activeSessionIdRef,
    moveSession,
    openTabStateRef,
    persistOpenTabIntentState,
  ]);

  const handleRenameSession = useCallback((sessionId: string, name: string) => {
    const nextOpenTabState = renameOpenTabIntentSession(openTabStateRef.current, sessionId, name);
    persistOpenTabIntentState(nextOpenTabState, {
      fallbackActiveSessionId: activeSessionIdRef.current,
    });
    renameSession(sessionId, name);
  }, [
    activeSessionIdRef,
    openTabStateRef,
    persistOpenTabIntentState,
    renameSession,
  ]);

  const handleCloseSession = useCallback((sessionId: string, source = 'unknown') => {
    const runtimeSessions = sessionsRef.current;
    const currentRuntimeActiveSessionId = activeSessionIdRef.current;
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
  }, [activeSessionIdRef, applyClosedOpenTabIntent, sessionsRef]);

  const handleResumeSession = useCallback((sessionId: string) => {
    handleSwitchSession(sessionId);
  }, [handleSwitchSession]);

  return {
    handleSwitchSession,
    handleMoveSession,
    handleRenameSession,
    handleCloseSession,
    handleResumeSession,
  };
}
