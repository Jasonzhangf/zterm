import type { BridgeSettings } from './bridge-settings';
import { normalizeOpenTabIntentState } from './open-tab-intent';
import { buildSessionSemanticOwnerKey, sessionSemanticOwnersMatch } from './session-semantic-identity';
import { fetchTmuxSessions } from './tmux-sessions';
import { normalizeRemoteTmuxSessionNames } from './tmux-session-list';
import type { Host, PersistedOpenTab, Session } from './types';
import type { TerminalMuxTargetClientMessage } from '@zterm/shared/protocol';

const OPEN_TAB_REMOTE_RESTORE_TIMEOUT_MS = 2500;

export interface RestoreTabAvailabilityResult {
  restorableTabs: PersistedOpenTab[];
  droppedTabs: PersistedOpenTab[];
}

export interface RemoteRestorableOpenTabState {
  tabs: PersistedOpenTab[];
  activeSessionId: string | null;
  droppedTabs: PersistedOpenTab[];
}

interface TraversalSettings {
  signalUrl?: BridgeSettings['signalUrl'];
  turnServerUrl?: BridgeSettings['turnServerUrl'];
  turnUsername?: BridgeSettings['turnUsername'];
  turnCredential?: BridgeSettings['turnCredential'];
  transportMode?: BridgeSettings['transportMode'];
  traversalRelay?: BridgeSettings['traversalRelay'];
}

interface RemoteSessionOwnerTarget {
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  authToken?: string;
  terminalBackend?: 'tmux' | 'herdr';
}

interface ManagedRemoteSessionTarget {
  id: string;
  state: Session['state'];
  daemonHostId?: string;
  bridgeHost: string;
  bridgePort: number;
  createdAt?: number;
  terminalBackend?: 'tmux' | 'herdr';
}

function normalizeTerminalBackend(value: 'tmux' | 'herdr' | undefined) {
  return value === 'herdr' ? 'herdr' : 'tmux';
}

export function buildRemoteSessionOwnerKey(target: Pick<RemoteSessionOwnerTarget, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend'>) {
  const ownerKey = buildSessionSemanticOwnerKey(target);
  return normalizeTerminalBackend(target.terminalBackend) === 'herdr'
    ? `${ownerKey}::backend:herdr`
    : ownerKey;
}

function resolveReusableManagedRemoteSessionForTarget(
  sessions: ManagedRemoteSessionTarget[],
  target: RemoteSessionOwnerTarget,
  prioritySessionIds: Array<string | null | undefined> = [],
) {
  const matches = sessions.filter((session) => (
    session.state !== 'closed'
    && sessionSemanticOwnersMatch(session, target)
    && normalizeTerminalBackend(session.terminalBackend) === normalizeTerminalBackend(target.terminalBackend)
  ));
  if (matches.length === 0) {
    return null;
  }
  for (const prioritySessionId of prioritySessionIds) {
    const normalizedPrioritySessionId = prioritySessionId?.trim();
    if (!normalizedPrioritySessionId) {
      continue;
    }
    const matched = matches.find((session) => session.id === normalizedPrioritySessionId);
    if (matched) {
      return matched;
    }
  }
  return [...matches].sort((left, right) => {
    const stateScore = (session: ManagedRemoteSessionTarget) => (session.state === 'connected' ? 2 : session.state === 'connecting' ? 1 : 0);
    const scoreDelta = stateScore(right) - stateScore(left);
    if (scoreDelta !== 0) {
      return scoreDelta;
    }
    return (right.createdAt || 0) - (left.createdAt || 0);
  })[0] || null;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

function pickPreferredOwnerHost(current: Host | null, candidate: Host) {
  if (!current) {
    return candidate;
  }
  if (candidate.pinned !== current.pinned) {
    return candidate.pinned ? candidate : current;
  }
  const candidateRecency = Math.max(candidate.lastConnected || 0, candidate.createdAt || 0);
  const currentRecency = Math.max(current.lastConnected || 0, current.createdAt || 0);
  return candidateRecency >= currentRecency ? candidate : current;
}

function resolveOwnerHostId(
  host: Pick<Host, 'daemonHostId' | 'relayHostId'>,
) {
  return host.daemonHostId?.trim() || host.relayHostId?.trim() || '';
}

function resolveCanonicalRemoteSessionOwnerHost(
  target: RemoteSessionOwnerTarget,
  hosts: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'pinned' | 'lastConnected' | 'createdAt'>>,
) {
  const endpointMatches = hosts.filter((host) => (
    host.bridgeHost.trim() === target.bridgeHost.trim()
    && host.bridgePort === target.bridgePort
    && normalizeTerminalBackend((host as Pick<Host, 'terminalBackend'>).terminalBackend) === normalizeTerminalBackend(target.terminalBackend)
  ));
  const targetOwnerId = target.daemonHostId?.trim() || '';
  if (targetOwnerId) {
    const exactOwnerMatches = endpointMatches.filter((host) => resolveOwnerHostId(host) === targetOwnerId);
    if (exactOwnerMatches.length > 0) {
      return exactOwnerMatches.reduce<Host | null>((current, candidate) => (
        pickPreferredOwnerHost(current, candidate as Host)
      ), null);
    }
  }

  const endpointOwnerIds = new Set(
    endpointMatches.map(resolveOwnerHostId).filter(Boolean),
  );
  if (endpointOwnerIds.size > 1) {
    return null;
  }
  if (endpointOwnerIds.size === 0 && endpointMatches.length !== 1) {
    return null;
  }

  return endpointMatches.reduce<Host | null>((current, candidate) => (
    pickPreferredOwnerHost(current, candidate as Host)
  ), null);
}

export function resolveRemoteSessionOwnerTargets(options: {
  targets: Array<Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'terminalBackend'>>;
  hosts?: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'terminalBackend' | 'pinned' | 'lastConnected' | 'createdAt'>>;
}) {
  const resolvedTargetsByOwner = new Map<string, RemoteSessionOwnerTarget>();
  const preferredHostsByOwner = new Map<string, Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'pinned' | 'lastConnected' | 'createdAt'>>();

  for (const host of options.hosts || []) {
    const ownerKey = buildRemoteSessionOwnerKey({
      daemonHostId: host.daemonHostId || host.relayHostId,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
      terminalBackend: host.terminalBackend,
    });
    const current = preferredHostsByOwner.get(ownerKey) || null;
    preferredHostsByOwner.set(ownerKey, pickPreferredOwnerHost(current as Host | null, host as Host));
  }

  for (const target of options.targets) {
    const canonicalHost = resolveCanonicalRemoteSessionOwnerHost(target, options.hosts || []);
    const ownerTarget = canonicalHost ? {
      daemonHostId: canonicalHost.daemonHostId || canonicalHost.relayHostId || target.daemonHostId,
      bridgeHost: canonicalHost.bridgeHost,
      bridgePort: canonicalHost.bridgePort,
      authToken: canonicalHost.authToken || target.authToken,
      terminalBackend: target.terminalBackend,
    } : target;
    const ownerKey = buildRemoteSessionOwnerKey({
      daemonHostId: ownerTarget.daemonHostId,
      bridgeHost: ownerTarget.bridgeHost,
      bridgePort: ownerTarget.bridgePort,
      terminalBackend: ownerTarget.terminalBackend,
    });
    if (resolvedTargetsByOwner.has(ownerKey)) {
      continue;
    }
    const preferredHost = preferredHostsByOwner.get(ownerKey);
    if (preferredHost) {
      resolvedTargetsByOwner.set(ownerKey, {
        daemonHostId: preferredHost.daemonHostId || preferredHost.relayHostId || target.daemonHostId,
        bridgeHost: preferredHost.bridgeHost,
        bridgePort: preferredHost.bridgePort,
        authToken: preferredHost.authToken || ownerTarget.authToken,
        terminalBackend: ownerTarget.terminalBackend,
      });
      continue;
    }
    resolvedTargetsByOwner.set(ownerKey, {
      daemonHostId: ownerTarget.daemonHostId,
      bridgeHost: ownerTarget.bridgeHost,
      bridgePort: ownerTarget.bridgePort,
      authToken: ownerTarget.authToken,
      terminalBackend: ownerTarget.terminalBackend,
    });
  }

  return [...resolvedTargetsByOwner.values()];
}

export async function fetchRemoteTmuxSessionNamesByOwner(options: {
  targets: Array<Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'terminalBackend'>>;
  bridgeSettings: TraversalSettings;
  hosts?: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'terminalBackend' | 'pinned' | 'lastConnected' | 'createdAt'>>;
  openSessions?: Array<Pick<Session, 'id' | 'state' | 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'terminalBackend' | 'createdAt'>>;
  prioritySessionIds?: Array<string | null | undefined>;
  manageTmuxSessionsOnOpenTransport?: (
    sessionId: string,
    message: TerminalMuxTargetClientMessage,
  ) => Promise<string[] | null>;
}): Promise<Map<string, string[]>> {
  const traversalSettings = buildTraversalSettings(options.bridgeSettings);
  const sessionNamesByTarget = new Map<string, string[]>();
  const resolvedTargets = resolveRemoteSessionOwnerTargets({
    targets: options.targets,
    hosts: options.hosts,
  });

  const fetchResults = await Promise.all(resolvedTargets.map(async (target) => {
    const targetKey = buildRemoteSessionOwnerKey({
      daemonHostId: target.daemonHostId,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      terminalBackend: target.terminalBackend,
    });
    const reusableSession = options.manageTmuxSessionsOnOpenTransport && options.openSessions
      ? resolveReusableManagedRemoteSessionForTarget(
        options.openSessions,
        target,
        options.prioritySessionIds,
      )
      : null;
    if (reusableSession && options.manageTmuxSessionsOnOpenTransport) {
      try {
        const managedSessionNames = await options.manageTmuxSessionsOnOpenTransport(
          reusableSession.id,
          { type: 'list-sessions' },
        );
        if (managedSessionNames === null) {
          return { targetKey, sessionNames: [] as string[], ok: false as const };
        }
        const sessionNames = normalizeRemoteTmuxSessionNames(managedSessionNames);
        return { targetKey, sessionNames, ok: true as const };
      } catch (_error) {
        return { targetKey, sessionNames: [] as string[], ok: false as const };
      }
    }
    try {
      const sessionNames = normalizeRemoteTmuxSessionNames(await withTimeout(fetchTmuxSessions(
        {
          bridgeHost: target.bridgeHost,
          bridgePort: target.bridgePort,
          daemonHostId: target.daemonHostId,
          authToken: target.authToken,
          relayHostId: target.daemonHostId,
          terminalBackend: target.terminalBackend,
        },
        traversalSettings,
      ), OPEN_TAB_REMOTE_RESTORE_TIMEOUT_MS, `fetchTmuxSessions:${targetKey}`));
      return { targetKey, sessionNames, ok: true as const };
    } catch (_error) {
      return { targetKey, sessionNames: [] as string[], ok: false as const };
    }
  }));

  // Track which targets were successfully fetched
  const fetchedOwnerKeys = new Set<string>();
  for (const result of fetchResults) {
    if (!result.ok) {
      continue;
    }
    fetchedOwnerKeys.add(result.targetKey);
    if (!sessionNamesByTarget.has(result.targetKey)) {
      sessionNamesByTarget.set(result.targetKey, result.sessionNames);
    }
  }

  // Mark failed targets to distinguish "confirmed empty" from "fetch failed"
  // Empty string array signals "fetch failed / unknown" - audit must NOT use this to close tabs
  for (const resolvedTarget of resolvedTargets) {
    const targetKey = buildRemoteSessionOwnerKey({
      daemonHostId: resolvedTarget.daemonHostId,
      bridgeHost: resolvedTarget.bridgeHost,
      bridgePort: resolvedTarget.bridgePort,
      terminalBackend: resolvedTarget.terminalBackend,
    });
    if (!fetchedOwnerKeys.has(targetKey) && !sessionNamesByTarget.has(targetKey)) {
      sessionNamesByTarget.set(targetKey, []);
    }
  }

  return sessionNamesByTarget;
}

function buildTraversalSettings(settings: TraversalSettings): TraversalSettings & {
  signalUrl: string;
  turnServerUrl: string;
  turnUsername: string;
  turnCredential: string;
  transportMode: NonNullable<BridgeSettings['transportMode']>;
} {
  return {
    signalUrl: settings.signalUrl?.trim() || '',
    turnServerUrl: settings.turnServerUrl?.trim() || '',
    turnUsername: settings.turnUsername?.trim() || '',
    turnCredential: settings.turnCredential || '',
    transportMode: settings.transportMode || 'auto',
    traversalRelay: settings.traversalRelay,
  };
}


export function filterRestorableOpenTabsByRemoteSessionNames(options: {
  tabs: PersistedOpenTab[];
  sessionNamesByTarget: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>;
}): RestoreTabAvailabilityResult {
  return {
    restorableTabs: options.tabs,
    droppedTabs: [],
  };
}

export async function filterRestorableOpenTabsByRemoteTmuxSessions(options: {
  tabs: PersistedOpenTab[];
  bridgeSettings: TraversalSettings;
  hosts?: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'terminalBackend' | 'pinned' | 'lastConnected' | 'createdAt'>>;
}): Promise<RestoreTabAvailabilityResult> {
  if (options.tabs.length === 0) {
    return {
      restorableTabs: [],
      droppedTabs: [],
    };
  }

  const sessionNamesByTarget = await fetchRemoteTmuxSessionNamesByOwner({
    targets: options.tabs,
    bridgeSettings: options.bridgeSettings,
    hosts: options.hosts,
  });

  return filterRestorableOpenTabsByRemoteSessionNames({
    tabs: options.tabs,
    sessionNamesByTarget,
  });
}

export async function resolveRemoteRestorableOpenTabState(options: {
  tabs: PersistedOpenTab[];
  activeSessionId: string | null;
  bridgeSettings: TraversalSettings;
  hosts?: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'terminalBackend' | 'pinned' | 'lastConnected' | 'createdAt'>>;
}): Promise<RemoteRestorableOpenTabState> {
  const availability = await filterRestorableOpenTabsByRemoteTmuxSessions({
    tabs: options.tabs,
    bridgeSettings: options.bridgeSettings,
    hosts: options.hosts,
  });
  const normalizedState = normalizeOpenTabIntentState(
    availability.restorableTabs,
    options.activeSessionId,
  );
  return {
    tabs: normalizedState.tabs,
    activeSessionId: normalizedState.activeSessionId,
    droppedTabs: availability.droppedTabs,
  };
}
