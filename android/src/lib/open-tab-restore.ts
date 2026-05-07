import type { BridgeSettings } from './bridge-settings';
import { normalizeOpenTabIntentState } from './open-tab-intent';
import { buildSessionSemanticOwnerKey } from './session-semantic-identity';
import { fetchTmuxSessions } from './tmux-sessions';
import { normalizeRemoteTmuxSessionNames } from './tmux-session-list';
import type { Host, PersistedOpenTab } from './types';

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
}

function buildTabTargetKey(tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>) {
  return buildSessionSemanticOwnerKey({
    daemonHostId: tab.daemonHostId,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
  });
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

export function resolveRemoteSessionOwnerTargets(options: {
  targets: Array<Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken'>>;
  hosts?: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'pinned' | 'lastConnected' | 'createdAt'>>;
}) {
  const resolvedTargetsByOwner = new Map<string, RemoteSessionOwnerTarget>();
  const preferredHostsByOwner = new Map<string, Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'pinned' | 'lastConnected' | 'createdAt'>>();

  for (const host of options.hosts || []) {
    const ownerKey = buildSessionSemanticOwnerKey({
      daemonHostId: host.daemonHostId || host.relayHostId,
      bridgeHost: host.bridgeHost,
      bridgePort: host.bridgePort,
    });
    const current = preferredHostsByOwner.get(ownerKey) || null;
    preferredHostsByOwner.set(ownerKey, pickPreferredOwnerHost(current as Host | null, host as Host));
  }

  for (const target of options.targets) {
    const ownerKey = buildSessionSemanticOwnerKey({
      daemonHostId: target.daemonHostId,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
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
        authToken: preferredHost.authToken || target.authToken,
      });
      continue;
    }
    resolvedTargetsByOwner.set(ownerKey, {
      daemonHostId: target.daemonHostId,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
      authToken: target.authToken,
    });
  }

  return [...resolvedTargetsByOwner.values()];
}

export async function fetchRemoteTmuxSessionNamesByOwner(options: {
  targets: Array<Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'authToken'>>;
  bridgeSettings: TraversalSettings;
  hosts?: Array<Pick<Host, 'daemonHostId' | 'relayHostId' | 'bridgeHost' | 'bridgePort' | 'authToken' | 'pinned' | 'lastConnected' | 'createdAt'>>;
}): Promise<Map<string, string[]>> {
  const traversalSettings = buildTraversalSettings(options.bridgeSettings);
  const sessionNamesByTarget = new Map<string, string[]>();
  const resolvedTargets = resolveRemoteSessionOwnerTargets({
    targets: options.targets,
    hosts: options.hosts,
  });

  for (const target of resolvedTargets) {
    const targetKey = buildSessionSemanticOwnerKey({
      daemonHostId: target.daemonHostId,
      bridgeHost: target.bridgeHost,
      bridgePort: target.bridgePort,
    });
    if (sessionNamesByTarget.has(targetKey)) {
      continue;
    }
    const sessionNames = normalizeRemoteTmuxSessionNames(await fetchTmuxSessions(
      {
        bridgeHost: target.bridgeHost,
        bridgePort: target.bridgePort,
        daemonHostId: target.daemonHostId,
        authToken: target.authToken,
        relayHostId: target.daemonHostId,
      },
      traversalSettings,
    ));
    sessionNamesByTarget.set(targetKey, sessionNames);
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
  if (options.tabs.length === 0) {
    return {
      restorableTabs: [],
      droppedTabs: [],
    };
  }

  const restorableTabs: PersistedOpenTab[] = [];
  const droppedTabs: PersistedOpenTab[] = [];
  for (const tab of options.tabs) {
    const targetKey = buildTabTargetKey(tab);
    const rawSessionNames = options.sessionNamesByTarget.get(targetKey);
    const sessionNames = rawSessionNames instanceof Set
      ? rawSessionNames
      : new Set(rawSessionNames || []);
    if (sessionNames.has(tab.sessionName.trim())) {
      restorableTabs.push(tab);
      continue;
    }
    droppedTabs.push(tab);
  }

  return {
    restorableTabs,
    droppedTabs,
  };
}

export async function filterRestorableOpenTabsByRemoteTmuxSessions(options: {
  tabs: PersistedOpenTab[];
  bridgeSettings: TraversalSettings;
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
}): Promise<RemoteRestorableOpenTabState> {
  const availability = await filterRestorableOpenTabsByRemoteTmuxSessions({
    tabs: options.tabs,
    bridgeSettings: options.bridgeSettings,
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
