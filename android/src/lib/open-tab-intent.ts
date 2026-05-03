import type { PersistedOpenTab, Session } from './types';
import {
  buildPersistedOpenTabFromSession,
  buildPersistedOpenTabReuseKey,
  buildPersistedOpenTabReuseKeyFromSession,
  dedupePersistedOpenTabs,
} from './open-tab-persistence';

export interface OpenTabIntentState {
  tabs: PersistedOpenTab[];
  activeSessionId: string | null;
}

export function normalizeOpenTabIntentState(
  tabs: PersistedOpenTab[],
  activeSessionId: string | null,
): OpenTabIntentState {
  const dedupedTabs = dedupePersistedOpenTabs(tabs);
  const normalizedActiveSessionId =
    activeSessionId && dedupedTabs.some((tab) => tab.sessionId === activeSessionId)
      ? activeSessionId
      : dedupedTabs[0]?.sessionId || null;
  return {
    tabs: dedupedTabs,
    activeSessionId: normalizedActiveSessionId,
  };
}

export function buildBootstrapOpenTabIntentStateFromSessions(
  sessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>,
  runtimeActiveSessionId: string | null,
): OpenTabIntentState {
  const tabs = sessions.map((session) => buildPersistedOpenTabFromSession(session));
  return normalizeOpenTabIntentState(tabs, runtimeActiveSessionId);
}

export function mergeRuntimeSessionsIntoOpenTabIntentState(
  currentState: OpenTabIntentState,
  sessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>,
  closedSessionIds: ReadonlySet<string>,
): OpenTabIntentState {
  const knownSessionIds = new Set(currentState.tabs.map((tab) => tab.sessionId));
  const runtimeNewTabs = sessions
    .filter((session) => !knownSessionIds.has(session.id) && !closedSessionIds.has(session.id))
    .map((session) => buildPersistedOpenTabFromSession(session));

  if (runtimeNewTabs.length === 0) {
    return currentState;
  }

  return normalizeOpenTabIntentState(
    [...currentState.tabs, ...runtimeNewTabs],
    currentState.activeSessionId,
  );
}

export function resolveRuntimeActiveSessionIdForOpenTabs(
  currentState: OpenTabIntentState,
  sessions: Array<Pick<Session, 'id'>>,
  runtimeActiveSessionId: string | null,
): string | null {
  if (
    currentState.activeSessionId
    && sessions.some((session) => session.id === currentState.activeSessionId)
  ) {
    return currentState.activeSessionId;
  }
  return runtimeActiveSessionId;
}

export function upsertOpenTabIntentSession(
  currentState: OpenTabIntentState,
  tab: PersistedOpenTab,
  options?: {
    activate?: boolean;
    fallbackActiveSessionId?: string | null;
  },
): OpenTabIntentState {
  return normalizeOpenTabIntentState(
    [...currentState.tabs.filter((item) => item.sessionId !== tab.sessionId), tab],
    options?.activate ? tab.sessionId : (currentState.activeSessionId || options?.fallbackActiveSessionId || null),
  );
}

export function activateOpenTabIntentSession(
  currentState: OpenTabIntentState,
  sessionId: string,
): OpenTabIntentState {
  return normalizeOpenTabIntentState(currentState.tabs, sessionId);
}

export function moveOpenTabIntentSession(
  currentState: OpenTabIntentState,
  sessionId: string,
  toIndex: number,
): OpenTabIntentState {
  const currentIndex = currentState.tabs.findIndex((tab) => tab.sessionId === sessionId);
  if (currentIndex < 0) {
    return currentState;
  }

  const nextTabs = [...currentState.tabs];
  const [moved] = nextTabs.splice(currentIndex, 1);
  const nextIndex = Math.max(0, Math.min(toIndex, nextTabs.length));
  nextTabs.splice(nextIndex, 0, moved);
  return normalizeOpenTabIntentState(nextTabs, currentState.activeSessionId);
}

export function renameOpenTabIntentSession(
  currentState: OpenTabIntentState,
  sessionId: string,
  customName: string,
): OpenTabIntentState {
  const normalizedName = customName.trim();
  return normalizeOpenTabIntentState(
    currentState.tabs.map((tab) => (
      tab.sessionId === sessionId
        ? {
            ...tab,
            customName: normalizedName || undefined,
          }
        : tab
    )),
    currentState.activeSessionId,
  );
}

export function closeOpenTabIntentSession(
  currentState: OpenTabIntentState,
  sessionId: string,
  options?: {
    runtimeActiveSessionId?: string | null;
    fallbackSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'>>;
  },
): OpenTabIntentState {
  const targetSession = options?.runtimeSessions?.find((session) => session.id === sessionId) || null;
  const targetReuseKey = targetSession
    ? buildPersistedOpenTabReuseKeyFromSession(targetSession)
    : null;
  const nextTabs = currentState.tabs.filter((tab) => (
    tab.sessionId !== sessionId
    && (!targetReuseKey || buildPersistedOpenTabReuseKey(tab) !== targetReuseKey)
  ));
  const requestedActiveSessionId =
    currentState.activeSessionId === sessionId
      ? (
        nextTabs[0]?.sessionId
        || options?.fallbackSessionIds?.find((id) => id !== sessionId)
        || null
      )
      : (
        options?.runtimeActiveSessionId === sessionId
          ? currentState.activeSessionId
          : (currentState.activeSessionId || options?.runtimeActiveSessionId || null)
      );

  return normalizeOpenTabIntentState(nextTabs, requestedActiveSessionId);
}

export function resolveRequestedOpenTabFocusSessionId(
  tabs: Array<Pick<PersistedOpenTab, 'sessionId'>>,
  requestedActiveSessionId?: string,
) {
  const normalizedRequested =
    typeof requestedActiveSessionId === 'string' && requestedActiveSessionId.trim()
      ? requestedActiveSessionId.trim()
      : '';
  if (normalizedRequested && tabs.some((tab) => tab.sessionId === normalizedRequested)) {
    return normalizedRequested;
  }
  return tabs[0]?.sessionId || null;
}
