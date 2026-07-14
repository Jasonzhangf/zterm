import { findReusableManagedSession } from '../contexts/session-reconnect-helpers';
import {
  buildSessionSemanticReuseKey,
  buildSessionSemanticReuseKeyVariants,
  sessionSemanticReuseMatch,
} from './session-semantic-identity';
import { STORAGE_KEYS, type Host, type PersistedOpenTab, type Session } from './types';

export type PersistedActiveSessionIdState =
  | { status: 'unavailable' | 'empty' | 'available'; activeSessionId: string | null }
  | { status: 'failed'; activeSessionId: null; error: unknown };

export type PersistedOpenTabsState =
  | { status: 'unavailable' | 'empty'; tabs: PersistedOpenTab[]; hasStoredValue: false }
  | { status: 'available'; tabs: PersistedOpenTab[]; hasStoredValue: true }
  | { status: 'invalid' | 'failed'; tabs: PersistedOpenTab[]; hasStoredValue: boolean; error: unknown };

export type PersistOpenTabsStateResult =
  | { ok: true }
  | { ok: false; error: unknown };

export function readPersistedActiveSessionId() {
  return readPersistedActiveSessionIdState().activeSessionId;
}

export function readPersistedActiveSessionIdState(): PersistedActiveSessionIdState {
  if (typeof window === 'undefined') {
    return { status: 'unavailable', activeSessionId: null };
  }

  try {
    clearLegacyOpenTabPersistence();
    return { status: 'empty', activeSessionId: null };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to clear legacy active session:', error);
    return { status: 'failed', activeSessionId: null, error };
  }
}

export function persistActiveSessionId(activeSessionId: string | null): PersistOpenTabsStateResult {
  void activeSessionId;
  if (typeof window === 'undefined') {
    return { ok: true };
  }

  try {
    clearLegacyOpenTabPersistence();
    return { ok: true };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to clear legacy active session:', error);
    return { ok: false, error };
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
  const daemonHostId = typeof candidate.daemonHostId === 'string' ? candidate.daemonHostId.trim() : '';

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
    daemonHostId: daemonHostId || undefined,
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

export function buildPersistedOpenTabReuseKey(tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>) {
  return buildSessionSemanticReuseKey({
    daemonHostId: tab.daemonHostId,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
    sessionName: tab.sessionName,
  });
}

export function buildPersistedOpenTabReuseKeyVariants(tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>) {
  return buildSessionSemanticReuseKeyVariants({
    daemonHostId: tab.daemonHostId,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
    sessionName: tab.sessionName,
  });
}

export function buildPersistedOpenTabReuseKeyFromSession(session: Pick<
  Session,
  'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'
>) {
  return buildPersistedOpenTabReuseKey({
    daemonHostId: session.daemonHostId,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
  });
}

export function buildPersistedOpenTabReuseKeyVariantsFromSession(session: Pick<
  Session,
  'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'
>) {
  return buildPersistedOpenTabReuseKeyVariants({
    daemonHostId: session.daemonHostId,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
  });
}

export function persistedOpenTabsSemanticallyMatch(
  left: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>,
  right: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>,
) {
  return sessionSemanticReuseMatch(left, right);
}

export function persistedOpenTabMatchesSession(
  tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>,
  session: Pick<Session, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>,
) {
  return sessionSemanticReuseMatch(tab, session);
}

export function readPersistedOpenTabs() {
  return readPersistedOpenTabsState().tabs;
}

export function readPersistedOpenTabsState(): PersistedOpenTabsState {
  if (typeof window === 'undefined') {
    return {
      status: 'unavailable',
      tabs: [] as PersistedOpenTab[],
      hasStoredValue: false,
    };
  }

  try {
    clearLegacyOpenTabPersistence();
    return {
      status: 'empty',
      tabs: [] as PersistedOpenTab[],
      hasStoredValue: false,
    };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to clear legacy open tabs:', error);
    return {
      status: 'failed',
      tabs: [] as PersistedOpenTab[],
      hasStoredValue: false,
      error,
    };
  }
}

export function buildPersistedOpenTabFromSession(session: Pick<
  Session,
  'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
>): PersistedOpenTab {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    daemonHostId: session.daemonHostId,
    sessionName: session.sessionName,
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  };
}

export function buildPersistedOpenTabFromHostSession(options: {
  sessionId: string;
  host: Pick<Host, 'id' | 'name' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId' | 'sessionName' | 'authToken' | 'autoCommand'>;
  customName?: string;
  createdAt: number;
}) {
  return {
    sessionId: options.sessionId,
    hostId: options.host.id,
    connectionName: options.host.name,
    bridgeHost: options.host.bridgeHost,
    bridgePort: options.host.bridgePort,
    daemonHostId: options.host.daemonHostId || options.host.relayHostId,
    sessionName: options.host.sessionName,
    authToken: options.host.authToken,
    autoCommand: options.host.autoCommand,
    customName: options.customName?.trim() || undefined,
    createdAt: options.createdAt,
  };
}

export function persistOpenTabsState(tabs: PersistedOpenTab[], activeSessionId: string | null): PersistOpenTabsStateResult {
  void tabs;
  void activeSessionId;
  if (typeof window === 'undefined') {
    return { ok: true };
  }

  try {
    clearLegacyOpenTabPersistence();
    return { ok: true };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to clear legacy open tabs:', error);
    return { ok: false, error };
  }
}

const CLOSED_TAB_REUSE_KEYS_STORAGE_KEY = 'zterm:closed-tab-reuse-keys';

export function readPersistedClosedTabReuseKeys(): Set<string> {
  if (typeof window === 'undefined') {
    return new Set();
  }
  try {
    localStorage.removeItem(CLOSED_TAB_REUSE_KEYS_STORAGE_KEY);
    return new Set();
  } catch (error) {
    console.error('[open-tab-persistence] Failed to clear closed tab reuse keys:', error);
    return new Set();
  }
}

export function persistClosedTabReuseKeys(keys: Set<string>) {
  void keys;
  if (typeof window === 'undefined') {
    return;
  }
  try {
    localStorage.removeItem(CLOSED_TAB_REUSE_KEYS_STORAGE_KEY);
  } catch (error) {
    console.error('[open-tab-persistence] Failed to clear closed tab reuse keys:', error);
  }
}

function clearLegacyOpenTabPersistence() {
  localStorage.removeItem(STORAGE_KEYS.OPEN_TABS);
  localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
  localStorage.removeItem(STORAGE_KEYS.SAVED_TAB_LISTS);
  localStorage.removeItem(CLOSED_TAB_REUSE_KEYS_STORAGE_KEY);
}

export function clearClosedTabReuseKeysForOwner(
  keys: Set<string>,
  target: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>,
) {
  const variants = buildPersistedOpenTabReuseKeyVariants(target);
  let deletedAny = false;
  variants.forEach((key) => {
    if (keys.delete(key)) {
      deletedAny = true;
    }
  });
  return deletedAny;
}

export function findReusableOpenTabSession(options: {
  sessions: Session[];
  host: Pick<Host, 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId' | 'sessionName' | 'authToken'>;
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
      daemonHostId: options.host.daemonHostId || options.host.relayHostId,
      relayHostId: options.host.relayHostId || options.host.daemonHostId,
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
  const existingHost = hosts.find((host) => host.id === tab.hostId)
    || hosts.find((host) => persistedOpenTabsSemanticallyMatch(host, tab))
    || null;
  if (existingHost) {
    return {
      ...existingHost,
      name: existingHost.name || tab.connectionName,
      bridgeHost: existingHost.bridgeHost || tab.bridgeHost,
      bridgePort: existingHost.bridgePort || tab.bridgePort,
      daemonHostId: existingHost.daemonHostId || tab.daemonHostId || existingHost.relayHostId,
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
    daemonHostId: tab.daemonHostId,
    relayHostId: tab.daemonHostId,
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
