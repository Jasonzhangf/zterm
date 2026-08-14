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
    const connectionsProjectionSource = readSource('pages/ConnectionsPage.tsx');

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
    const connectionsProjectionSource = readSource('pages/ConnectionsPage.tsx');

    expect(sessionHistorySource).toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(sessionHistorySource).toContain('localStorage.getItem(STORAGE_KEYS.SESSION_GROUPS)');

    expect(openTabPersistenceSource).not.toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(openTabRuntimeSource).not.toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(connectionsProjectionSource).not.toContain('STORAGE_KEYS.SESSION_GROUPS');
    expect(connectionsProjectionSource).not.toContain('localStorage.');
  });

  it('keeps connections projection read-only and free of storage/runtime mutation', () => {
    const connectionsProjectionSource = readSource('pages/ConnectionsPage.tsx');
    const relaySettingsSectionSource = readSource('components/settings/RelayAccountSettingsSection.tsx');

    expect(connectionsProjectionSource).toContain('export function ConnectionsPage');
    expect(connectionsProjectionSource).not.toContain('getDefaultTraversalRelayBaseUrl');
    expect(relaySettingsSectionSource).toContain('getDefaultTraversalRelayBaseUrl');
    expect(connectionsProjectionSource).not.toContain('connections-server-groups');
    expect(connectionsProjectionSource).not.toContain('createSession(');
    expect(connectionsProjectionSource).not.toContain('closeSession(');
    expect(connectionsProjectionSource).not.toContain('switchSession(');
    expect(connectionsProjectionSource).not.toContain('persistOpenTabsState(');
    expect(connectionsProjectionSource).not.toContain('onOpenServerGroups');
    expect(connectionsProjectionSource).not.toContain('onSaveServerGroupSelection');
    expect(connectionsProjectionSource).not.toContain('localStorage.');
  });

  it('keeps app-layer createSession reopen ownership limited to restore/runtime-sync and explicit user open actions', () => {
    const appSource = readSource('App.tsx');
    const restoreRuntimeSource = readSource('hooks/useOpenTabRestoreRuntimeSync.ts');
    const sessionOpenActionsSource = readSource('hooks/useSessionOpenActions.ts');
    const openTabSessionActionsSource = readSource('hooks/useOpenTabSessionActions.ts');
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');
    const openTabOpenPolicySource = readSource('lib/open-tab-open-policy.ts');
    const sessionHistorySource = readSource('hooks/useSessionHistoryStorage.ts');
    const connectionsPageSource = readSource('pages/ConnectionsPage.tsx');

    expect(restoreRuntimeSource).toContain('createSession(');
    expect(restoreRuntimeSource).toContain("buildOpenTabSessionCreateOptions('cold-restore'");
    expect(sessionOpenActionsSource).toContain('createSession(');
    expect(openTabOpenPolicySource).toContain('buildOpenTabSessionCreateOptions(');
    expect(openTabRuntimeSource).toContain('createSession,');
    expect(appSource).toContain('hosts: homeSavedConnections,');
    expect(openTabSessionActionsSource).not.toContain('createSession(');
    expect(openTabOpenPolicySource).toContain("'cold-restore': {");
    expect(openTabOpenPolicySource).toContain('connectOnCreate: false');

    expect(sessionHistorySource).not.toContain('createSession(');
    expect(connectionsPageSource).not.toContain('createSession(');
  });

  it('keeps cold restore read-only and removes saved-tab import revival paths', () => {
    const restoreRuntimeSource = readSource('hooks/useOpenTabRestoreRuntimeSync.ts');
    const sessionOpenActionsSource = readSource('hooks/useSessionOpenActions.ts');
    const openTabOpenPolicySource = readSource('lib/open-tab-open-policy.ts');

    expect(restoreRuntimeSource).not.toContain('persistClosedTabReuseKeys(');
    expect(restoreRuntimeSource).not.toContain('closedOpenTabReuseKeysRef.current.add(');
    expect(restoreRuntimeSource).not.toContain('clearClosedTabReuseKeysForOwner(');
    expect(restoreRuntimeSource).not.toContain('closedOpenTabReuseKeysRef.current.delete(');
    expect(restoreRuntimeSource).not.toContain("source: 'saved-tab-import-revive'");

    expect(sessionOpenActionsSource).toContain('clearClosedTabReuseKeysForOwner(');
    expect(sessionOpenActionsSource).not.toContain('persistClosedTabReuseKeys(');
    expect(openTabOpenPolicySource).toContain("'explicit-open': {");
    expect(openTabOpenPolicySource).toContain("'cold-restore': {");
    expect(openTabOpenPolicySource).not.toContain('saved-tab-import');
    expect(openTabOpenPolicySource).not.toContain('saved-tab-import-revive');
    expect(openTabOpenPolicySource).not.toContain('reconcileImportedTabsWithClosedReuseKeys(');
    expect(openTabOpenPolicySource).not.toContain('reviveClosedReuseOnImport');
  });

  it('keeps remote tmux audits unable to close open tabs automatically', () => {
    const remoteTabAuditSource = readSource('lib/remote-tab-audit.ts');
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');

    expect(remoteTabAuditSource).not.toContain('applyClosedOpenTabIntent');
    expect(remoteTabAuditSource).not.toContain('closeRuntimeSession');
    expect(remoteTabAuditSource).not.toContain('closeSession(');
    expect(remoteTabAuditSource).not.toContain('persistClosedTabReuseKeys(');
    expect(openTabRuntimeSource).not.toContain('useOpenTabRemoteAudit');
  });

  it('keeps terminal tab chrome materialized from OPEN_TABS instead of filtering by live runtime sessions', () => {
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');

    expect(openTabRuntimeSource).toContain('materializeOpenTabRuntimeSessions(openTabState.tabs, sessions)');
    expect(openTabRuntimeSource).not.toContain(".filter((session): session is Session => session !== null)");
  });

  it('keeps runtime tab switching owned by applyOpenTabState instead of exposing extra switch/persist refs to child hooks', () => {
    const sessionOpenActionsSource = readSource('hooks/useSessionOpenActions.ts');
    const openTabSessionActionsSource = readSource('hooks/useOpenTabSessionActions.ts');
    const restoreRuntimeSource = readSource('hooks/useOpenTabRestoreRuntimeSync.ts');
    const openTabRuntimeSource = readSource('hooks/useOpenTabRuntime.ts');

    expect(sessionOpenActionsSource).not.toContain('persistAndSwitchExplicitOpenTabsRef');
    expect(openTabSessionActionsSource).not.toContain('requestRuntimeActiveSessionSwitch(');
    expect(restoreRuntimeSource).not.toContain('requestRuntimeActiveSessionSwitch(');
    expect(openTabSessionActionsSource).toContain("switchRuntime: 'explicit-resume'");
    expect(restoreRuntimeSource).toContain('restoreSwitchReason: OpenTabRuntimeSwitchReason;');
    expect(restoreRuntimeSource).toContain('switchRuntime: restoreSwitchReason');
    expect(openTabRuntimeSource).toContain("restoreSwitchReason: OpenTabRuntimeSwitchReason;");
    expect(openTabRuntimeSource).toContain("switchReason === 'explicit-resume'");
    expect(openTabRuntimeSource).toContain('const shouldResumeUnavailableRuntime = (');
    expect(openTabRuntimeSource).toContain("targetRuntimeSession.state === 'idle'");
    expect(openTabRuntimeSource).toContain("targetRuntimeSession.state === 'closed'");
    expect(openTabRuntimeSource).toContain("targetRuntimeSession.state === 'disconnected'");
    expect(openTabRuntimeSource).toContain("targetRuntimeSession.state === 'error'");
    expect(openTabRuntimeSource).not.toContain("if (switchReason === 'restore-sync')");
  });
});
