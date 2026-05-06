import type { BridgeSettings } from './bridge-settings';
import { normalizeOpenTabIntentState } from './open-tab-intent';
import { buildSessionSemanticOwnerKey } from './session-semantic-identity';
import { fetchTmuxSessions } from './tmux-sessions';
import type { PersistedOpenTab } from './types';

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

function buildTabTargetKey(tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort'>) {
  return buildSessionSemanticOwnerKey({
    daemonHostId: tab.daemonHostId,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
  });
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

  const traversalSettings = buildTraversalSettings(options.bridgeSettings);
  const sessionListsByTarget = new Map<string, Set<string>>();

  for (const tab of options.tabs) {
    const targetKey = buildTabTargetKey(tab);
    if (sessionListsByTarget.has(targetKey)) {
      continue;
    }
    const sessionNames = await fetchTmuxSessions(
      {
        bridgeHost: tab.bridgeHost,
        bridgePort: tab.bridgePort,
        daemonHostId: tab.daemonHostId,
        authToken: tab.authToken,
        relayHostId: tab.daemonHostId,
      },
      traversalSettings,
    );
    sessionListsByTarget.set(targetKey, new Set(sessionNames.map((name) => name.trim()).filter(Boolean)));
  }

  const restorableTabs: PersistedOpenTab[] = [];
  const droppedTabs: PersistedOpenTab[] = [];
  for (const tab of options.tabs) {
    const targetKey = buildTabTargetKey(tab);
    const sessionNames = sessionListsByTarget.get(targetKey);
    if (sessionNames?.has(tab.sessionName.trim())) {
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
