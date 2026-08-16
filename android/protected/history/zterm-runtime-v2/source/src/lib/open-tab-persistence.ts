import { findReusableManagedSession } from './session-reconnect-helpers';
import {
  buildSessionSemanticOwnerKey,
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
    const raw = localStorage.getItem(STORAGE_KEYS.ACTIVE_SESSION);
    const activeSessionId = typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    return activeSessionId
      ? { status: 'available', activeSessionId }
      : { status: 'empty', activeSessionId: null };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to restore active session:', error);
    return { status: 'failed', activeSessionId: null, error };
  }
}

export function persistActiveSessionId(activeSessionId: string | null): PersistOpenTabsStateResult {
  void activeSessionId;
  if (typeof window === 'undefined') {
    return { ok: true };
  }

  try {
    const normalized = typeof activeSessionId === 'string' ? activeSessionId.trim() : '';
    if (normalized) {
      localStorage.setItem(STORAGE_KEYS.ACTIVE_SESSION, normalized);
      return { ok: true };
    }
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
    return { ok: true };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to persist active session:', error);
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
    terminalBackend: candidate.terminalBackend === 'herdr' ? 'herdr' : 'tmux',
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

export function buildPersistedOpenTabReuseKey(tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'terminalBackend'>) {
  return buildSessionSemanticReuseKey({
    daemonHostId: tab.daemonHostId,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
    sessionName: tab.sessionName,
    terminalBackend: tab.terminalBackend,
  });
}

export function buildPersistedOpenTabReuseKeyVariants(tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'terminalBackend'>) {
  return buildSessionSemanticReuseKeyVariants({
    daemonHostId: tab.daemonHostId,
    bridgeHost: tab.bridgeHost,
    bridgePort: tab.bridgePort,
    sessionName: tab.sessionName,
    terminalBackend: tab.terminalBackend,
  });
}

export function buildPersistedOpenTabReuseKeyFromSession(session: Pick<
  Session,
  'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'terminalBackend'
>) {
  return buildPersistedOpenTabReuseKey({
    daemonHostId: session.daemonHostId,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    terminalBackend: session.terminalBackend,
  });
}

export function buildPersistedOpenTabReuseKeyVariantsFromSession(session: Pick<
  Session,
  'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'terminalBackend'
>) {
  return buildPersistedOpenTabReuseKeyVariants({
    daemonHostId: session.daemonHostId,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    terminalBackend: session.terminalBackend,
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
    const raw = localStorage.getItem(STORAGE_KEYS.OPEN_TABS);
    if (!raw) {
      return {
        status: 'empty',
        tabs: [] as PersistedOpenTab[],
        hasStoredValue: false,
      };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return {
        status: 'invalid',
        tabs: [] as PersistedOpenTab[],
        hasStoredValue: true,
        error: new Error('Persisted OPEN_TABS value is not an array'),
      };
    }
    return {
      status: 'available',
      tabs: parsed
        .map(normalizePersistedOpenTab)
        .filter((item): item is PersistedOpenTab => item !== null),
      hasStoredValue: true,
    };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to restore open tabs:', error);
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
  'id' | 'hostId' | 'connectionName' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'sessionName' | 'terminalBackend' | 'authToken' | 'autoCommand' | 'customName' | 'createdAt'
>): PersistedOpenTab {
  return {
    sessionId: session.id,
    hostId: session.hostId,
    connectionName: session.connectionName,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    daemonHostId: session.daemonHostId,
    sessionName: session.sessionName,
    terminalBackend: session.terminalBackend || 'tmux',
    authToken: session.authToken,
    autoCommand: session.autoCommand,
    customName: session.customName,
    createdAt: session.createdAt,
  };
}

export function buildPersistedOpenTabFromHostSession(options: {
  sessionId: string;
  host: Pick<Host, 'id' | 'name' | 'bridgeHost' | 'bridgePort' | 'daemonHostId' | 'relayHostId' | 'sessionName' | 'terminalBackend' | 'authToken' | 'autoCommand'>;
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
    terminalBackend: options.host.terminalBackend || 'tmux',
    authToken: options.host.authToken,
    autoCommand: options.host.autoCommand,
    customName: options.customName?.trim() || undefined,
    createdAt: options.createdAt,
  };
}

export function persistOpenTabsState(tabs: PersistedOpenTab[], activeSessionId: string | null): PersistOpenTabsStateResult {
  if (typeof window === 'undefined') {
    return { ok: true };
  }

  try {
    if (tabs.length === 0) {
      localStorage.removeItem(STORAGE_KEYS.OPEN_TABS);
      return persistActiveSessionId(null);
    }
    localStorage.setItem(STORAGE_KEYS.OPEN_TABS, JSON.stringify(tabs));
    const activeSessionResult = persistActiveSessionId(activeSessionId);
    if (!activeSessionResult.ok) {
      return activeSessionResult;
    }
    return { ok: true };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to persist open tabs:', error);
    return { ok: false, error };
  }
}

const CLOSED_TAB_REUSE_KEYS_STORAGE_KEY = 'zterm:closed-tab-reuse-keys';

export function clearLegacyTabListAndTombstoneStorage(): PersistOpenTabsStateResult {
  if (typeof window === 'undefined') {
    return { ok: true };
  }

  try {
    localStorage.removeItem(STORAGE_KEYS.OPEN_TABS);
    localStorage.removeItem(STORAGE_KEYS.ACTIVE_SESSION);
    localStorage.removeItem(STORAGE_KEYS.SAVED_TAB_LISTS);
    localStorage.removeItem(CLOSED_TAB_REUSE_KEYS_STORAGE_KEY);
    return { ok: true };
  } catch (error) {
    console.error('[open-tab-persistence] Failed to migrate legacy tab-list storage:', error);
    return { ok: false, error };
  }
}

function pickPreferredPersistedHost(left: Host, right: Host) {
  if (left.pinned !== right.pinned) {
    return right.pinned ? right : left;
  }
  const leftRecency = Math.max(left.lastConnected || 0, left.createdAt || 0);
  const rightRecency = Math.max(right.lastConnected || 0, right.createdAt || 0);
  return rightRecency >= leftRecency ? right : left;
}

function resolveUniqueEndpointSessionHost(hosts: Host[]) {
  if (hosts.length === 0) {
    return null;
  }
  const ownerKeys = new Set(hosts.map((host) => buildSessionSemanticOwnerKey(host)));
  if (ownerKeys.size !== 1) {
    return null;
  }
  return hosts.reduce((current, candidate) => (
    current ? pickPreferredPersistedHost(current, candidate) : candidate
  ), null as Host | null);
}

export function clearClosedTabReuseKeysForOwner(
  keys: Set<string>,
  target: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName' | 'terminalBackend'>,
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

export interface FindReusableOpenTabSessionOptions {
  /**
   * client-owned sessionId from the persisted open tab. Required. Two persisted
   * tabs that share host + sessionName (because the underlying tmux session got
   * renamed) must not collapse; each sessionId is its own authority.
   */
  sessionId: string;
  sessions: Session[];
  activeSessionId: string | null;
}

/**
 * Look up a persisted open tab by exact client-owned sessionId. Callers must
 * read `sessionId` from the persisted tab record (not derive it from host or
 * sessionName) and pass it here. Returning null forces the caller to mint a new
 * sessionId via SessionContext.createSession rather than reusing a stale one.
 */
export function findReusableOpenTabSession(options: FindReusableOpenTabSessionOptions) {
  return findReusableManagedSession({
    sessionId: options.sessionId,
    sessions: options.sessions,
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
  const exactPersistedHost = tab.hostId
    ? hosts.find((host) => host.id === tab.hostId) || null
    : null;
  const semanticHost = hosts
    .filter((host) => persistedOpenTabsSemanticallyMatch(host, tab))
    .reduce((current, candidate) => (
      current ? pickPreferredPersistedHost(current, candidate) : candidate
    ), null as Host | null);
  const endpointSessionMatches = hosts.filter((host) => (
    host.bridgeHost.trim() === tab.bridgeHost.trim()
    && host.bridgePort === tab.bridgePort
    && (
      host.sessionName.trim() === tab.sessionName.trim()
      || host.sessionName.trim() === ''
    )
  ));
  const existingHost = (
    exactPersistedHost
    || semanticHost
    || resolveUniqueEndpointSessionHost(endpointSessionMatches)
  );
  if (existingHost) {
    return {
      ...existingHost,
      name: existingHost.name || tab.connectionName,
      bridgeHost: existingHost.bridgeHost || tab.bridgeHost,
      bridgePort: existingHost.bridgePort || tab.bridgePort,
      daemonHostId: existingHost.daemonHostId || tab.daemonHostId || existingHost.relayHostId,
      sessionName: existingHost.sessionName || tab.sessionName,
      terminalBackend: existingHost.terminalBackend || tab.terminalBackend || 'tmux',
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
    terminalBackend: tab.terminalBackend || 'tmux',
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
