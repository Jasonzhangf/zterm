import {
  buildPersistedOpenTabReuseKeyVariants,
  clearClosedTabReuseKeysForOwner,
} from './open-tab-persistence';
import type { PersistedOpenTab } from './types';

export type OpenTabOpenSource =
  | 'explicit-open'
  | 'saved-tab-import'
  | 'saved-tab-import-revive'
  | 'cold-restore';

interface OpenTabOpenPolicy {
  connectOnCreate: boolean;
  clearClosedReuseOnOpen: boolean;
  reviveClosedReuseOnImport: boolean;
}

const OPEN_TAB_OPEN_POLICIES: Record<OpenTabOpenSource, OpenTabOpenPolicy> = {
  'explicit-open': {
    connectOnCreate: true,
    clearClosedReuseOnOpen: true,
    reviveClosedReuseOnImport: false,
  },
  'saved-tab-import': {
    connectOnCreate: true,
    clearClosedReuseOnOpen: false,
    reviveClosedReuseOnImport: false,
  },
  'saved-tab-import-revive': {
    connectOnCreate: true,
    clearClosedReuseOnOpen: true,
    reviveClosedReuseOnImport: true,
  },
  'cold-restore': {
    connectOnCreate: false,
    clearClosedReuseOnOpen: false,
    reviveClosedReuseOnImport: false,
  },
};

export function resolveOpenTabOpenPolicy(source: OpenTabOpenSource): OpenTabOpenPolicy {
  return OPEN_TAB_OPEN_POLICIES[source];
}

export function buildOpenTabSessionCreateOptions(
  source: OpenTabOpenSource,
  options?: {
    customName?: string;
    createdAt?: number;
    sessionId?: string;
  },
) {
  const policy = resolveOpenTabOpenPolicy(source);
  return {
    activate: false as const,
    connect: policy.connectOnCreate,
    customName: options?.customName,
    createdAt: options?.createdAt,
    sessionId: options?.sessionId,
  };
}

function hasClosedReuseKeyForTab(
  closedReuseKeys: ReadonlySet<string>,
  tab: Pick<PersistedOpenTab, 'daemonHostId' | 'bridgeHost' | 'bridgePort' | 'sessionName'>,
) {
  return buildPersistedOpenTabReuseKeyVariants(tab).some((key) => closedReuseKeys.has(key));
}

export function reconcileImportedTabsWithClosedReuseKeys(options: {
  tabs: PersistedOpenTab[];
  closedReuseKeys: Set<string>;
  source: Extract<OpenTabOpenSource, 'saved-tab-import' | 'saved-tab-import-revive'>;
}) {
  const policy = resolveOpenTabOpenPolicy(options.source);
  if (!policy.reviveClosedReuseOnImport) {
    return {
      tabs: options.tabs.filter((tab) => !hasClosedReuseKeyForTab(options.closedReuseKeys, tab)),
      changed: false,
    };
  }

  let changed = false;
  options.tabs.forEach((tab) => {
    if (clearClosedTabReuseKeysForOwner(options.closedReuseKeys, tab)) {
      changed = true;
    }
  });
  return {
    tabs: options.tabs,
    changed,
  };
}
