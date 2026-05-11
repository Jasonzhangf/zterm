import { describe, expect, it } from 'vitest';
import {
  buildOpenTabSessionCreateOptions,
  reconcileImportedTabsWithClosedReuseKeys,
  resolveOpenTabOpenPolicy,
} from './open-tab-open-policy';

describe('open-tab open policy truth', () => {
  it('keeps explicit-open / saved-import / cold-restore switches in one policy table', () => {
    expect(resolveOpenTabOpenPolicy('explicit-open')).toEqual({
      connectOnCreate: true,
      clearClosedReuseOnOpen: true,
      reviveClosedReuseOnImport: false,
    });
    expect(resolveOpenTabOpenPolicy('saved-tab-import')).toEqual({
      connectOnCreate: true,
      clearClosedReuseOnOpen: false,
      reviveClosedReuseOnImport: false,
    });
    expect(resolveOpenTabOpenPolicy('saved-tab-import-revive')).toEqual({
      connectOnCreate: true,
      clearClosedReuseOnOpen: true,
      reviveClosedReuseOnImport: true,
    });
    expect(resolveOpenTabOpenPolicy('cold-restore')).toEqual({
      connectOnCreate: false,
      clearClosedReuseOnOpen: false,
      reviveClosedReuseOnImport: false,
    });
  });

  it('builds createSession options from the centralized policy truth', () => {
    expect(buildOpenTabSessionCreateOptions('explicit-open', { sessionId: 'tab-a' })).toEqual({
      activate: false,
      connect: true,
      customName: undefined,
      createdAt: undefined,
      sessionId: 'tab-a',
    });
    expect(buildOpenTabSessionCreateOptions('cold-restore', { sessionId: 'tab-a', createdAt: 1 })).toEqual({
      activate: false,
      connect: false,
      customName: undefined,
      createdAt: 1,
      sessionId: 'tab-a',
    });
  });

  it('filters closed tabs on normal saved-tab import but clears tombstones on revive import', () => {
    const tab = {
      sessionId: 'saved-a',
      hostId: 'host-a',
      connectionName: 'Conn A',
      bridgeHost: '100.127.23.27',
      bridgePort: 3333,
      daemonHostId: 'daemon-a',
      sessionName: 'shared',
      authToken: 'token-a',
      createdAt: 1,
    };
    const closedReuseKeys = new Set([
      'daemon:daemon-a::session:shared',
      'bridge:100.127.23.27::3333::session:shared',
    ]);

    expect(reconcileImportedTabsWithClosedReuseKeys({
      tabs: [tab],
      closedReuseKeys: new Set(closedReuseKeys),
      source: 'saved-tab-import',
    })).toEqual({
      tabs: [],
      changed: false,
    });

    const reviveKeys = new Set(closedReuseKeys);
    expect(reconcileImportedTabsWithClosedReuseKeys({
      tabs: [tab],
      closedReuseKeys: reviveKeys,
      source: 'saved-tab-import-revive',
    })).toEqual({
      tabs: [tab],
      changed: true,
    });
    expect(Array.from(reviveKeys)).toEqual([]);
  });
});
