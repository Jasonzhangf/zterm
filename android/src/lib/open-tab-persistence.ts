import { findReusableManagedSession } from '../contexts/session-sync-helpers';
import { STORAGE_KEYS, type Host, type PersistedOpenTab, type Session } from './types';

export function readPersistedActiveSessionId() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
  } catch (error) {
    console.error('[open-tab-persistence] Failed to restore active session:', error);
    return null;
  }
}

export function persistActiveSessionId(activeSessionId: string | null) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const normalized = typeof activeSessionId === 'string' ? activeSessionId.trim() : '';
    if (normalized) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, normalized);
      return;
    }
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
  } catch (error) {
    console.error('[open-tab-persistence] Failed to persist active session:', error);
  }
}

export function normalizePersistedOpenTab(input: unknown): PersistedOpenTab | null {
  if (!input || typeof input !== 'object') {
    return null;
  }

  const candidate = input as Partial<PersistedOpenTab>;
  const sessionId = typeof candidate.sessionId === 'string' ? candidate.sessionId.trim() : '';
  const hostId = typeof candidate.hostId === 'string' ? candidate.hostId.trim() : '';
  const bridgeHost = typeof candidate.bridgeHost === 'string' ? candidate.bridgeHost.trim() : '';
  const sessionName = typeof candidate.sessionName === 'string' ? candidate.sessionName.trim() : '';
  const connectionName = typeof candidate.connectionName === 'string' ? candidate.connectionName.trim() : '';

  if (!sessionId || !bridgeHost || !sessionName) {
    return null;
  }

  return {
    sessionId,
    hostId,
    connectionName: connectionName || sessionName,
    bridgeHost,
    bridgePort:
      typeof candidate.bridgePort === 'number' && Number.isFinite(candidate.bridgePort)
        ? candidate.bridgePort
        : 3333,
    sessionName,
    authToken: typeof candidate.authToken === 'string' ? candidate.authToken : undefined,
    autoCommand: typeof candidate.autoCommand === 'string' ? candidate.autoCommand : undefined,
    customName: typeof candidate.customName === 'string' && candidate.customName.trim()
      ? candidate.customName.trim()
      : undefined,
    createdAt:
      typeof candidate.createdAt === 'number' && Number.isFinite(candidate.createdAt)
        ? candidate.createdAt
        : Date.now(),
  };
}

export function buildPersistedOpenTabReuseKey(tab: Pick<PersistedOpenTab, 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'>) {
  return [
    tab.bridgeHost.trim(),
    String(tab.bridgePort),
    tab.sessionName.trim(),
    tab.authToken?.trim() || '',
  ].join('::');
}

export function buildPersistedOpenTabReuseKeyFromSession(session: Pick<
  Session,
  'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'
>) {
  return buildPersistedOpenTabReuseKey({
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken,
  });
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

export function readPersistedOpenTabs() {
  if (typeof window === 'undefined') {
    return [] as PersistedOpenTab[];
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.OPEN_TABS);
    if (!raw) {
      return [] as PersistedOpenTab[];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [] as PersistedOpenTab[];
    }
    return dedupePersistedOpenTabs(parsed
      .map(normalizePersistedOpenTab)
      .filter((item): item is PersistedOpenTab => item !== null));
  } catch (error) {
    console.error('[open-tab-persistence] Failed to restore open tabs:', error);
    return [] as PersistedOpenTab[];
  }
}

export function buildPersistedOpenTabFromSession(session: Pick<
  Session,
  'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
>): PersistedOpenTab {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  };
}

export function buildPersistedOpenTabFromHostSession(options: {
  sessionId: string;
  host: Pick<Host, 'id' | 'name' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand'>;
  customName?: string;
  createdAt: number;
}) {
  return {
    sessionId: options.sessionId,
    hostId: options.host.id,
    connectionName: options.host.name,
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    sessionName: options.host.sessionName,
    authToken: options.host.authToken,
    autoCommand: options.host.autoCommand,
    customName: options.customName?.trim() || undefined,
    createdAt: options.createdAt,
  };
}

export function persistOpenTabsState(tabs: PersistedOpenTab[], activeSessionId: string | null) {
  if (typeof window === 'undefined') {
    return;
  }

  try {
    const dedupedTabs = dedupePersistedOpenTabs(tabs);
    const normalizedActiveSessionId =
      activeSessionId && dedupedTabs.some((tab) => tab.sessionId === activeSessionId)
        ? activeSessionId
        : dedupedTabs[0]?.sessionId || null;
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify(dedupedTabs));
    persistActiveSessionId(normalizedActiveSessionId);
  } catch (error) {
    console.error('[open-tab-persistence] Failed to persist open tabs:', error);
  }
}

export function persistSessionIntentState(options: {
  sessions: Array<Pick<
    Session,
    'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
  >>;
  activeSessionId: string | null;
}) {
  persistOpenTabsState(
    options.sessions.map((session) => buildPersistedOpenTabFromSession(session)),
    options.activeSessionId,
  );
}

export function findReusableOpenTabSession(options: {
  sessions: Session[];
  host: Pick<Host, 'bridgeHost' | 'bridgePort' | 'sessionName' | 'authToken'>;
  activeSessionId: string | null;
}) {
  return findReusableManagedSession({
    sessions: options.sessions,
    host: {
      id: 'open-tab-persistence',
      createdAt: 0,
      name: options.host.sessionName.trim() || options.host.bridgeHost.trim(),
      bridgeHost: options.host.bridgeHost,
      bridgePort: options.host.bridgePort,
      sessionName: options.host.sessionName,
      authToken: options.host.authToken,
      authType: 'password',
      tags: [],
      pinned: false,
    },
    resolvedSessionName: options.host.sessionName.trim() || options.host.bridgeHost.trim(),
    activeSessionId: options.activeSessionId,
  });
}

export function resolveHostForPersistedOpenTab(options: {
  tab: PersistedOpenTab;
  hosts: Host[];
  fallbackCreatedAt?: number;
  fallbackLastConnected?: number;
  fallbackIdPrefix?: string;
}) {
  const { tab, hosts } = options;
  const existingHost = hosts.find((host) => host.id === tab.hostId) || null;
  if (existingHost) {
    return {
      ...existingHost,
      name: existingHost.name || tab.connectionName,
      bridgeHost: existingHost.bridgeHost || tab.bridgeHost,
      bridgePort: existingHost.bridgePort || tab.bridgePort,
      sessionName: existingHost.sessionName || tab.sessionName,
      authToken: existingHost.authToken || tab.authToken,
      autoCommand: existingHost.autoCommand || tab.autoCommand,
    };
  }

  return {
    id: tab.hostId || `${options.fallbackIdPrefix || 'persisted'}:${tab.bridgeHost}:${tab.bridgePort}:${tab.sessionName}`,
    createdAt: options.fallbackCreatedAt ?? tab.createdAt,
    name: tab.connectionName,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
    sessionName: tab.sessionName,
    authToken: tab.authToken,
    autoCommand: tab.autoCommand,
    authType: 'password' as const,
    password: undefined,
    privateKey: undefined,
    tags: [],
    pinned: false,
    lastConnected: options.fallbackLastConnected ?? tab.createdAt,
  };
}
