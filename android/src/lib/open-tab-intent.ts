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

export function openTabIntentStatesEqual(
  left: OpenTabIntentState,
  right: OpenTabIntentState,
) {
  if (left.activeSessionId !== right.activeSessionId) {
    return false;
  }
  if (left.tabs.length !== right.tabs.length) {
    return false;
  }
  for (let index = 0; index < left.tabs.length; index += 1) {
    const leftTab = left.tabs[index]!;
    const rightTab = right.tabs[index]!;
    if (
      leftTab.sessionId !== rightTab.sessionId
      || leftTab.hostId !== rightTab.hostId
      || leftTab.connectionName !== rightTab.connectionName
      || leftTab.bridgeHost !== rightTab.bridgeHost
      || leftTab.bridgePort !== rightTab.bridgePort
      || leftTab.sessionName !== rightTab.sessionName
      || (leftTab.authToken || '') !== (rightTab.authToken || '')
      || (leftTab.autoCommand || '') !== (rightTab.autoCommand || '')
      || (leftTab.customName || '') !== (rightTab.customName || '')
      || leftTab.createdAt !== rightTab.createdAt
    ) {
      return false;
    }
  }
  return true;
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
  closedReuseKeys?: ReadonlySet<string>,
): OpenTabIntentState {
  const nextTabs = [...currentState.tabs];
  let nextActiveSessionId = currentState.activeSessionId;
  let changed = false;

  for (const session of sessions) {
    if (closedSessionIds.has(session.id)) {
      continue;
    }

    const runtimeTab = buildPersistedOpenTabFromSession(session);
    const runtimeReuseKey = buildPersistedOpenTabReuseKey(runtimeTab);
    if (closedReuseKeys?.has(runtimeReuseKey)) {
      continue;
    }
    const existingIndex = nextTabs.findIndex((tab) => (
      buildPersistedOpenTabReuseKey(tab) === runtimeReuseKey
    ));

    if (existingIndex >= 0) {
      const existingTab = nextTabs[existingIndex]!;
      if (existingTab.sessionId === runtimeTab.sessionId) {
        continue;
      }
      nextTabs[existingIndex] = {
        ...runtimeTab,
        customName: existingTab.customName?.trim() || runtimeTab.customName,
        createdAt: existingTab.createdAt || runtimeTab.createdAt,
      };
      if (nextActiveSessionId === existingTab.sessionId) {
        nextActiveSessionId = runtimeTab.sessionId;
      }
      changed = true;
      continue;
    }

    if (nextTabs.some((tab) => tab.sessionId === runtimeTab.sessionId)) {
      continue;
    }

    // OPEN_TABS is explicit client truth once it exists.
    // Runtime sessions may refresh or replace an existing semantic tab,
    // but must not append runtime-only tabs back into the persisted set.
    continue;
  }

  if (!changed) {
    return currentState;
  }

  return normalizeOpenTabIntentState(nextTabs, nextActiveSessionId);
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
