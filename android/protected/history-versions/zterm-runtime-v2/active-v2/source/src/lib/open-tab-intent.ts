import type { PersistedOpenTab, Session } from './types';
import {
  buildPersistedOpenTabFromSession,
  buildPersistedOpenTabReuseKey,
  buildPersistedOpenTabReuseKeyVariants,
  buildPersistedOpenTabReuseKeyVariantsFromSession,
} from './open-tab-persistence';

export interface OpenTabIntentState {
  tabs: PersistedOpenTab[];
  activeSessionId: string | null;
}

export interface CloseOpenTabIntentResult {
  nextState: OpenTabIntentState;
  closedReuseKey: string | null;
  closedReuseKeyVariants: string[];
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
  const deduped: PersistedOpenTab[] = [];
  for (const tab of tabs) {
    const existingIndex = deduped.findIndex((item) => item.sessionId === tab.sessionId);
    const existing = existingIndex >= 0 ? deduped[existingIndex]! : null;
    if (!existing) {
      deduped.push(tab);
      continue;
    }
    const preferred =
      (existing.customName?.trim() ? existing : tab.customName?.trim() ? tab : null)
      || (existing.createdAt >= tab.createdAt ? existing : tab);
    deduped[existingIndex] = preferred;
  }
  return deduped;
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
      || (leftTab.daemonHostId || '') !== (rightTab.daemonHostId || '')
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
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>,
  runtimeActiveSessionId: string | null,
): OpenTabIntentState {
  const tabs = sessions.map((session) => buildPersistedOpenTabFromSession(session));
  return normalizeOpenTabIntentState(tabs, runtimeActiveSessionId);
}

export function materializeOpenTabRuntimeSessions(
  tabs: PersistedOpenTab[],
  runtimeSessions: Session[],
): Session[] {
  const runtimeSessionsById = new Map(runtimeSessions.map((session) => [session.id, session]));
  return tabs.map((tab) => runtimeSessionsById.get(tab.sessionId) || {
    id: tab.sessionId,
    hostId: tab.hostId,
    connectionName: tab.connectionName,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
    daemonHostId: tab.daemonHostId,
    sessionName: tab.sessionName,
    terminalBackend: tab.terminalBackend || 'tmux',
    authToken: tab.authToken,
    autoCommand: tab.autoCommand,
    title: tab.customName?.trim() || tab.sessionName,
    ws: null,
    state: 'closed',
    hasUnread: false,
    customName: tab.customName,
    reconnectAttempt: 0,
    createdAt: tab.createdAt,
    lastError: 'Runtime transport is closed; explicit resume is required.',
  });
}

export function deriveRuntimeOpenTabSyncDecision(options: {
  currentState: OpenTabIntentState;
  runtimeSessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
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
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
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
    const runtimeReuseKeys = buildPersistedOpenTabReuseKeyVariantsFromSession(session);
    if (runtimeReuseKeys.some((key) => closedReuseKeys?.has(key))) {
      continue;
    }
    const existingIndex = nextTabs.findIndex((tab) => tab.sessionId === runtimeTab.sessionId);

    if (existingIndex >= 0) {
      continue;
    }

    if (nextTabs.some((tab) => tab.sessionId === runtimeTab.sessionId)) {
      continue;
    }

    // OPEN_TABS is explicit client truth once it exists.
    // Runtime sessions only refresh exact sessionId matches; semantic peers
    // must never merge, replace, append, or close an already-open tab.
    continue;
  }

  if (!changed) {
    return currentState;
  }

  return normalizeOpenTabIntentState(nextTabs, nextActiveSessionId);
}

export function upsertOpenTabIntentSession(
  currentState: OpenTabIntentState,
  tab: PersistedOpenTab,
  options?: {
    activate?: boolean;
    preserveActiveSessionId?: string | null;
  },
): OpenTabIntentState {
  const existingTab = currentState.tabs.find((item) => item.sessionId === tab.sessionId) || null;
  const nextTab = existingTab
    ? {
        ...tab,
        customName: existingTab.customName?.trim() || tab.customName,
        createdAt: existingTab.createdAt || tab.createdAt,
      }
    : tab;
  const shouldRewriteActiveSessionId = currentState.activeSessionId === tab.sessionId;
  const requestedActiveSessionId = options?.activate
    ? nextTab.sessionId
    : (
      shouldRewriteActiveSessionId
        ? nextTab.sessionId
        : (currentState.activeSessionId || options?.preserveActiveSessionId || null)
    );
  let inserted = false;
  return normalizeOpenTabIntentState(
    currentState.tabs.flatMap((item) => {
      if (item.sessionId !== tab.sessionId) {
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

// 远端 tmux rename-session 成功后的 open-tab 身份迁移：tmux session 名真源已变，
// sessionName（reuse key / reconnect 身份）必须同步为 nextName；已有本地 customName 保持独立。
export function renameRemoteOpenTabIntentSession(
  currentState: OpenTabIntentState,
  sessionId: string,
  nextName: string,
): OpenTabIntentState {
  const normalizedName = nextName.trim();
  return normalizeOpenTabIntentState(
    currentState.tabs.map((tab) => (
      tab.sessionId === sessionId
        ? {
            ...tab,
            sessionName: normalizedName || tab.sessionName,
            customName: tab.customName && tab.customName !== tab.sessionName
              ? tab.customName
              : normalizedName || undefined,
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
    nextActiveCandidateSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken'>>;
  },
): OpenTabIntentState {
  const nextTabs = currentState.tabs.filter((tab) => tab.sessionId !== sessionId);
  const requestedActiveSessionId =
    currentState.activeSessionId === sessionId
      ? (
        nextTabs[0]?.sessionId
        || options?.nextActiveCandidateSessionIds?.find((id) => id !== sessionId)
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
    nextActiveCandidateSessionIds?: string[];
    runtimeSessions?: Array<Pick<Session, 'id' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken'>>;
  },
): CloseOpenTabIntentResult {
  const targetSession = options?.runtimeSessions?.find((session) => session.id === sessionId) || null;
  const targetTab = currentState.tabs.find((tab) => tab.sessionId === sessionId) || null;
  const closedReuseKeySource = targetTab || targetSession;
  const closedReuseKeyVariants = [...new Set([
    ...(targetTab
      ? buildPersistedOpenTabReuseKeyVariants({
          daemonHostId: targetTab.daemonHostId,
          bridgeHost: targetTab.bridgeHost,
          bridgePort: targetTab.bridgePort,
          sessionName: targetTab.sessionName,
        })
      : []),
    ...(targetSession
      ? buildPersistedOpenTabReuseKeyVariants({
          daemonHostId: targetSession.daemonHostId,
          bridgeHost: targetSession.bridgeHost,
          bridgePort: targetSession.bridgePort,
          sessionName: targetSession.sessionName,
        })
      : []),
  ])];
  return {
    nextState: closeOpenTabIntentSession(currentState, sessionId, options),
    closedReuseKey: closedReuseKeySource
      ? buildPersistedOpenTabReuseKey({
          daemonHostId: closedReuseKeySource.daemonHostId,
          bridgeHost: closedReuseKeySource.bridgeHost,
          bridgePort: closedReuseKeySource.bridgePort,
          sessionName: closedReuseKeySource.sessionName,
        })
      : null,
    closedReuseKeyVariants,
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

export function resolveRequestedOpenTabActiveSessionId(
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
