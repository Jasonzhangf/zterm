import type { PersistedOpenTab, Session } from './types';
import {
  buildPersistedOpenTabFromSession,
  buildPersistedOpenTabReuseKey,
  buildPersistedOpenTabReuseKeyFromSession,
} from './open-tab-persistence';

export interface OpenTabIntentState {
  tabs: PersistedOpenTab[];
  activeSessionId: string | null;
}

export interface CloseOpenTabIntentResult {
  nextState: OpenTabIntentState;
  closedReuseKey: string | null;
}

export interface RuntimeOpenTabSyncDecision {
  kind: 'noop' | 'bootstrap' | 'merge' | 'switch';
  state?: OpenTabIntentState;
  activeSessionId?: string | null;
}

export interface PersistedOpenTabRestorePlan {
  kind: 'empty' | 'restore';
  tabs: PersistedOpenTab[];
  activeSessionId: string | null;
}

export function dedupePersistedOpenTabs(tabs: PersistedOpenTab[]) {
  const byKey = new Map<string, PersistedOpenTab>();
  for (const tab of tabs) {
    const key = buildPersistedOpenTabReuseKey(tab);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, tab);
      continue;
    }
    const preferred =
      (existing.customName?.trim() ? existing : tab.customName?.trim() ? tab : null)
      || (existing.createdAt >= tab.createdAt ? existing : tab);
    byKey.set(key, preferred);
  }
  return Array.from(byKey.values());
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

export function deriveRuntimeOpenTabSyncDecision(options: {
  currentState: OpenTabIntentState;
  runtimeSessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>;
  runtimeActiveSessionId: string | null;
  restoredTabsHandled: boolean;
  hasPersistedOpenTabsTruth: boolean;
  closedSessionIds: ReadonlySet<string>;
  closedReuseKeys?: ReadonlySet<string>;
}): RuntimeOpenTabSyncDecision {
  if (options.runtimeSessions.length === 0) {
    return { kind: 'noop' };
  }

  const shouldBootstrapFromRuntime =
    !options.restoredTabsHandled
    && options.currentState.tabs.length === 0
    && !options.hasPersistedOpenTabsTruth;
  if (shouldBootstrapFromRuntime) {
    return {
      kind: 'bootstrap',
      state: buildBootstrapOpenTabIntentStateFromSessions(
        options.runtimeSessions,
        options.runtimeActiveSessionId,
      ),
    };
  }

  if (options.currentState.tabs.length === 0 && options.hasPersistedOpenTabsTruth) {
    return { kind: 'noop' };
  }

  const runtimeMergedState = mergeRuntimeSessionsIntoOpenTabIntentState(
    options.currentState,
    options.runtimeSessions,
    options.closedSessionIds,
    options.closedReuseKeys,
  );
  if (runtimeMergedState !== options.currentState) {
    return {
      kind: 'merge',
      state: runtimeMergedState,
    };
  }

  if (options.restoredTabsHandled) {
    const runtimeActiveSessionId = options.runtimeActiveSessionId;
    if (
      runtimeActiveSessionId
      && runtimeActiveSessionId !== options.currentState.activeSessionId
      && options.currentState.tabs.some((tab) => tab.sessionId === runtimeActiveSessionId)
    ) {
      return {
        kind: 'merge',
        state: normalizeOpenTabIntentState(
          options.currentState.tabs,
          runtimeActiveSessionId,
        ),
      };
    }
    return { kind: 'noop' };
  }

  const requestedActiveSessionId = options.currentState.activeSessionId;
  const runtimeSessionIds = new Set(options.runtimeSessions.map((session) => session.id));
  if (
    requestedActiveSessionId
    && runtimeSessionIds.has(requestedActiveSessionId)
    && options.runtimeActiveSessionId !== requestedActiveSessionId
  ) {
    return {
      kind: 'switch',
      activeSessionId: requestedActiveSessionId,
    };
  }

  return { kind: 'noop' };
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
  const targetReuseKey = buildPersistedOpenTabReuseKey(tab);
  const semanticDuplicate = currentState.tabs.find((item) => (
    buildPersistedOpenTabReuseKey(item) === targetReuseKey
  )) || null;
  const nextTab = semanticDuplicate
    ? {
        ...tab,
        customName: semanticDuplicate.customName?.trim() || tab.customName,
        createdAt: semanticDuplicate.createdAt || tab.createdAt,
      }
    : tab;
  const shouldRewriteActiveSessionId = currentState.tabs.some((item) => (
    item.sessionId === currentState.activeSessionId
    && (
      item.sessionId === tab.sessionId
      || buildPersistedOpenTabReuseKey(item) === targetReuseKey
    )
  ));
  const requestedActiveSessionId = options?.activate
    ? nextTab.sessionId
    : (
      shouldRewriteActiveSessionId
        ? nextTab.sessionId
        : (currentState.activeSessionId || options?.fallbackActiveSessionId || null)
    );
  let inserted = false;
  return normalizeOpenTabIntentState(
    currentState.tabs.flatMap((item) => {
      const matchesSemanticTarget =
        item.sessionId === tab.sessionId
        || buildPersistedOpenTabReuseKey(item) === targetReuseKey;
      if (!matchesSemanticTarget) {
        return [item];
      }
      if (inserted) {
        return [];
      }
      inserted = true;
      return [nextTab];
    }).concat(inserted ? [] : [nextTab]),
    requestedActiveSessionId,
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

export function deriveCloseOpenTabIntent(
  currentState: OpenTabIntentState,
  sessionId: string,
  options?: {
    runtimeActiveSessionId?: string | null;
    fallbackSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'>>;
  },
): CloseOpenTabIntentResult {
  const targetSession = options?.runtimeSessions?.find((session) => session.id === sessionId) || null;
  const targetTab = currentState.tabs.find((tab) => tab.sessionId === sessionId) || null;
  const closedReuseKeySource = targetTab || targetSession;
  return {
    nextState: closeOpenTabIntentSession(currentState, sessionId, options),
    closedReuseKey: closedReuseKeySource
      ? buildPersistedOpenTabReuseKey({
          bridgeHost: closedReuseKeySource.bridgeHost,
          bridgePort: closedReuseKeySource.bridgePort,
          sessionName: closedReuseKeySource.sessionName,
          authToken: closedReuseKeySource.authToken,
        })
      : null,
  };
}

export function resolveRestoredOpenTabIntentState(
  currentState: OpenTabIntentState,
  restoredSessionIdRemap: ReadonlyMap<string, string>,
): OpenTabIntentState {
  if (restoredSessionIdRemap.size === 0) {
    return currentState;
  }
  const resolvedTabs = currentState.tabs.map((tab) => {
    const remappedSessionId = restoredSessionIdRemap.get(tab.sessionId);
    return remappedSessionId
      ? { ...tab, sessionId: remappedSessionId }
      : tab;
  });
  const resolvedActiveSessionId = currentState.activeSessionId
    ? (restoredSessionIdRemap.get(currentState.activeSessionId) || currentState.activeSessionId)
    : null;
  return normalizeOpenTabIntentState(resolvedTabs, resolvedActiveSessionId);
}

export function derivePersistedOpenTabRestorePlan(
  currentState: OpenTabIntentState,
): PersistedOpenTabRestorePlan {
  if (currentState.tabs.length === 0) {
    return {
      kind: 'empty',
      tabs: [],
      activeSessionId: null,
    };
  }

  return {
    kind: 'restore',
    tabs: currentState.tabs,
    activeSessionId: currentState.activeSessionId && currentState.tabs.some((tab) => tab.sessionId === currentState.activeSessionId)
      ? currentState.activeSessionId
      : currentState.tabs[0]?.sessionId || null,
  };
}

export function resolveSavedOpenTabsImportPlan(
  tabs: PersistedOpenTab[],
  requestedActiveSessionId?: string,
) {
  const dedupedTabs = dedupePersistedOpenTabs(tabs);
  return {
    tabs: dedupedTabs,
    focusSessionId: resolveRequestedOpenTabFocusSessionId(dedupedTabs, requestedActiveSessionId),
  };
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
