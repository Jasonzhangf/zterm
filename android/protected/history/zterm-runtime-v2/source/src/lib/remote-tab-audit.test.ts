import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BridgeSettings } from './bridge-settings';
import type { PersistedOpenTab } from './types';
import type { RemoteTabAuditDeps } from './remote-tab-audit';

const makeBridgeSettings = (): BridgeSettings => ({
  targetHost: '127.0.0.1',
  targetPort: 8080,
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
} as BridgeSettings);

describe('auditOpenTabsAgainstRemoteSessions', () => {
  let deps: RemoteTabAuditDeps;
  let pruneSessionGroupSelectionToRemoteTruth: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    pruneSessionGroupSelectionToRemoteTruth = vi.fn();
    deps = {
      openTabStateRef: { current: { tabs: [], activeSessionId: null } },
      sessionGroups: [],
      bridgeSettingsRef: { current: makeBridgeSettings() },
      hostsRef: { current: [] },
      remoteOpenTabAuditTokenRef: { current: 0 },
      pruneSessionGroupSelectionToRemoteTruth,
    };
  });

  // ── RED TEST: must NOT close tabs when remote fetch returns empty result ──
  // This simulates the case where WebSocket fails/times out - empty array means "unknown", not "confirmed empty"
  it('does NOT flag tabs as missing when remote fetch returns empty result', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };

    deps.openTabStateRef.current.tabs = [tab];
    // Simulate: fetch returned empty array (could be failed fetch or genuinely empty)
    const fetchMock = vi.fn().mockResolvedValue(new Map([['daemon:daemon-1', []]]));

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');

    const debugLogs: Array<{ event: string; data: unknown }> = [];
    const runtimeDebugModule = await import('./runtime-debug');
    vi.spyOn(runtimeDebugModule, 'runtimeDebug').mockImplementation((event, data) => {
      debugLogs.push({ event, data });
    });

    await audit('test-reason', deps);

    // RED ASSERTION: empty array must NOT trigger "remote-session-missing" log
    const missingLogs = debugLogs.filter((log) => log.event === 'app.open-tabs.remote-session-missing');
    expect(missingLogs).toHaveLength(0);
  });

  // ── FORWARD TEST: closes tabs only when session is positively confirmed missing ──
  it('flags tab as missing when remote confirms session does not exist', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };

    deps.openTabStateRef.current.tabs = [tab];
    // Simulate: fetch succeeded and returned a NON-EMPTY list that does NOT include our tab
    const fetchMock = vi.fn().mockResolvedValue(
      new Map([['daemon:daemon-1', ['other-session-1', 'other-session-2']]]),
    );

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    const runtimeDebugModule = await import('./runtime-debug');
    const runtimeDebugMock = vi.spyOn(runtimeDebugModule, 'runtimeDebug').mockImplementation(vi.fn());

    await audit('test-reason', deps);

    // FORWARD: should log missing when session is confirmed absent
    expect(runtimeDebugMock).toHaveBeenCalledWith(
      'app.open-tabs.remote-session-missing',
      expect.objectContaining({ sessionIds: ['session-1'] }),
    );
  });

  it('keeps tab open when remote confirms session exists', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };

    deps.openTabStateRef.current.tabs = [tab];
    // Simulate: fetch succeeded and returned a list that INCLUDES our tab
    const fetchMock = vi.fn().mockResolvedValue(
      new Map([['daemon:daemon-1', ['my-session', 'other-session']]]),
    );

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    const runtimeDebugModule = await import('./runtime-debug');
    const runtimeDebugMock = vi.spyOn(runtimeDebugModule, 'runtimeDebug').mockImplementation(vi.fn());

    await audit('test-reason', deps);

    // Should NOT log missing when session is confirmed present
    expect(runtimeDebugMock).not.toHaveBeenCalledWith(
      'app.open-tabs.remote-session-missing',
      expect.anything(),
    );
  });

  it('does not flag tabs as missing when no entry exists for that owner in the result map', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };

    deps.openTabStateRef.current.tabs = [tab];
    // Simulate: fetch returned empty map (no entries at all)
    const fetchMock = vi.fn().mockResolvedValue(new Map());

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    const runtimeDebugModule = await import('./runtime-debug');
    const runtimeDebugMock = vi.spyOn(runtimeDebugModule, 'runtimeDebug').mockImplementation(vi.fn());

    await audit('test-reason', deps);

    // Should NOT log missing when owner key is not in result map
    expect(runtimeDebugMock).not.toHaveBeenCalledWith(
      'app.open-tabs.remote-session-missing',
      expect.anything(),
    );
  });

  it('does not prune session groups when remote fetch result is empty or unknown', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };

    deps.openTabStateRef.current.tabs = [tab];
    deps.sessionGroups = [{
      id: 'group-1',
      name: 'group',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      authToken: 'token',
      sessionNames: ['my-session'],
      lastOpenedAt: Date.now(),
      missingSessionNames: [],
    }];
    const fetchMock = vi.fn().mockResolvedValue(new Map([['daemon:daemon-1', []]]));

    const pruneSpy = vi.fn();
    deps.pruneSessionGroupSelectionToRemoteTruth = pruneSpy;

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    await audit('test-reason', deps);

    expect(pruneSpy).not.toHaveBeenCalled();
  });

  it('passes current open sessions and mux target manager to remote owner fetch', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['my-session']);
    const liveSession = {
      id: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      title: 'my-session',
      authToken: 'token',
      ws: null,
      state: 'connected',
      hasUnread: false,
      createdAt: 1,
      buffer: {
        lines: [],
        gapRanges: [],
        startIndex: 0,
        endIndex: 0,
        bufferHeadStartIndex: 0,
        bufferTailEndIndex: 0,
        cols: 80,
        rows: 24,
        cursorKeysApp: false,
        cursor: null,
        updateKind: 'replace',
        revision: 0,
      },
    } as any;
    deps.openTabStateRef.current = { tabs: [tab], activeSessionId: 'session-1' };
    deps.sessionsRef = { current: [liveSession] };
    deps.prioritySessionIdsRef = { current: ['session-1'] };
    deps.manageTmuxSessionsOnOpenTransport = manageTmuxSessionsOnOpenTransport;
    const fetchMock = vi.fn().mockResolvedValue(new Map([['daemon:daemon-1', ['my-session']]]));

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    await audit('session-picker-refresh', deps);

    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      openSessions: [liveSession],
      prioritySessionIds: ['session-1'],
      manageTmuxSessionsOnOpenTransport,
    }));
  });

  it('does not audit persisted session groups on foreground resume', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };
    deps.openTabStateRef.current.tabs = [tab];
    deps.sessionGroups = [{
      id: 'group-1',
      name: 'group',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'daemon-history',
      authToken: 'token-history',
      sessionNames: ['history-session'],
      lastOpenedAt: Date.now(),
      missingSessionNames: [],
    }];
    const fetchMock = vi.fn().mockResolvedValue(new Map([['daemon:daemon-1', ['my-session']]]));

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    await audit('appStateChange', deps);

    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      targets: [tab],
    }));
    expect(pruneSessionGroupSelectionToRemoteTruth).not.toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-history' }),
      expect.anything(),
    );
  });

  it('keeps session group audit for explicit picker refresh', async () => {
    const tab: PersistedOpenTab = {
      sessionId: 'session-1',
      hostId: 'host-1',
      connectionName: 'test-host',
      bridgeHost: '192.168.1.100',
      bridgePort: 8080,
      daemonHostId: 'daemon-1',
      sessionName: 'my-session',
      authToken: 'token',
      createdAt: Date.now(),
    };
    const group = {
      id: 'group-1',
      name: 'group',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      daemonHostId: 'daemon-history',
      authToken: 'token-history',
      sessionNames: ['history-session'],
      lastOpenedAt: Date.now(),
      missingSessionNames: [],
    };
    deps.openTabStateRef.current.tabs = [tab];
    deps.sessionGroups = [group];
    const fetchMock = vi.fn().mockResolvedValue(new Map([
      ['daemon:daemon-1', ['my-session']],
      ['daemon:daemon-history', ['history-session']],
    ]));

    vi.resetModules();
    vi.doMock('./open-tab-restore', () => ({
      fetchRemoteTmuxSessionNamesByOwner: fetchMock,
    }));
    vi.doMock('./runtime-debug', () => ({
      runtimeDebug: vi.fn(),
    }));

    const { auditOpenTabsAgainstRemoteSessions: audit } = await import('./remote-tab-audit');
    await audit('session-picker-refresh', deps);

    expect(fetchMock).toHaveBeenCalledWith(expect.objectContaining({
      targets: [tab, group],
    }));
    expect(pruneSessionGroupSelectionToRemoteTruth).toHaveBeenCalledWith(
      expect.objectContaining({ daemonHostId: 'daemon-history' }),
      ['history-session'],
    );
  });
});
