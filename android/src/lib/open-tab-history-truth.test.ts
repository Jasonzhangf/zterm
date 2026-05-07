import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

function readSource(path: string) {
  return readFileSync(join(process.cwd(), 'src', ...path.split('/')), 'utf8');
}

describe('open-tab / history / connections truth gates', () => {
  it('keeps open-tab storage truth isolated to the open-tab persistence module', () => {
    const openTabPersistenceSource = readSource('lib/open-tab-persistence.ts');
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');
    const sessionContextSource = readSource('contexts/SessionContext.tsx');
    const sessionHistorySource = readSource('hooks/useSessionHistoryStorage.ts');
    const connectionsProjectionSource = readSource('lib/connections-server-groups.ts');

    expect(openTabPersistenceSource).toContain('STORAGE_KEYS.OPEN_TABS');
    expect(openTabPersistenceSource).toContain('STORAGE_KEYS.ACTIVE_SESSION');

    expect(openTabRuntimeSource).not.toContain('localStorage.');
    expect(sessionContextSource).not.toContain('STORAGE_KEYS.OPEN_TABS');
    expect(sessionContextSource).not.toContain('STORAGE_KEYS.ACTIVE_SESSION');
    expect(sessionContextSource).not.toContain('localStorage.');
    expect(sessionHistorySource).not.toContain('STORAGE_KEYS.OPEN_TABS');
    expect(connectionsProjectionSource).not.toContain('STORAGE_KEYS.OPEN_TABS');
    expect(connectionsProjectionSource).not.toContain('localStorage.');
  });

  it('keeps session history storage truth isolated to the session history hook', () => {
    const sessionHistorySource = readSource('hooks/useSessionHistoryStorage.ts');
    const openTabPersistenceSource = readSource('lib/open-tab-persistence.ts');
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');
    const connectionsProjectionSource = readSource('lib/connections-server-groups.ts');

    expect(sessionHistorySource).toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(sessionHistorySource).toContain('localStorage.getItem(STORAGE_KEYS.SESSION_GROUPS)');

    expect(openTabPersistenceSource).not.toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(openTabRuntimeSource).not.toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(connectionsProjectionSource).not.toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(connectionsProjectionSource).not.toContain('localStorage.');
  });

  it('keeps connections projection read-only and free of storage/runtime mutation', () => {
    const connectionsProjectionSource = readSource('lib/connections-server-groups.ts');

    expect(connectionsProjectionSource).toContain('export function buildConnectionsServerGroups');
    expect(connectionsProjectionSource).not.toContain('createSession(');
    expect(connectionsProjectionSource).not.toContain('closeSession(');
    expect(connectionsProjectionSource).not.toContain('switchSession(');
    expect(connectionsProjectionSource).not.toContain('persistOpenTabsState(');
    expect(connectionsProjectionSource).not.toContain('setSessionGroupSelection(');
    expect(connectionsProjectionSource).not.toContain('pruneSessionGroupSelectionToRemoteTruth(');
    expect(connectionsProjectionSource).not.toContain('localStorage.');
  });

  it('keeps app-layer createSession reopen ownership limited to restore/runtime-sync and explicit user open actions', () => {
    const restoreRuntimeSource = readSource('hooks/useOpenTabRestoreRuntimeSync.ts');
    const sessionOpenActionsSource = readSource('hooks/useSessionOpenActions.ts');
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');
    const sessionHistorySource = readSource('hooks/useSessionHistoryStorage.ts');
    const connectionsPageSource = readSource('pages/ConnectionsPage.tsx');

    expect(restoreRuntimeSource).toContain('createSession(');
    expect(sessionOpenActionsSource).toContain('createSession(');

    expect(openTabRuntimeSource).not.toContain('createSession(');
    expect(sessionHistorySource).not.toContain('createSession(');
    expect(connectionsPageSource).not.toContain('createSession(');
  });
});
