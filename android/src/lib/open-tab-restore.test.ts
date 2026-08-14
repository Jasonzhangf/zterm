// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fetchTmuxSessionsMock = vi.fn();

vi.mock('./tmux-sessions', () => ({
  fetchTmuxSessions: (...args: unknown[]) => fetchTmuxSessionsMock(...args),
}));

describe('open-tab restore truth', () => {
  beforeEach(() => {
    fetchTmuxSessionsMock.mockReset();
  });

  it('keeps persisted tabs even when their tmux session no longer exists remotely', async () => {
    fetchTmuxSessionsMock.mockResolvedValueOnce(['beta']);

    const { filterRestorableOpenTabsByRemoteTmuxSessions } = await import('./open-tab-restore');

    const result = await filterRestorableOpenTabsByRemoteTmuxSessions({
      tabs: [
        {
          sessionId: 'tab-a',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
        {
          sessionId: 'tab-b',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'beta',
          authToken: 'token-a',
          createdAt: 2,
        },
      ],
      bridgeSettings: {
        signalUrl: 'https://signal.example.com',
        turnServerUrl: 'turn:relay.example.com',
        turnUsername: 'alice',
        turnCredential: 'secret',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-a', 'tab-b']);
    expect(result.droppedTabs).toEqual([]);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(1);
  });

  it('preserves Herdr backend identity during persisted-tab restore discovery', async () => {
    fetchTmuxSessionsMock.mockResolvedValueOnce(['herdr-tab']);

    const { filterRestorableOpenTabsByRemoteTmuxSessions } = await import('./open-tab-restore');

    await filterRestorableOpenTabsByRemoteTmuxSessions({
      tabs: [{
        sessionId: 'herdr-tab-id',
        hostId: 'host-herdr',
        connectionName: 'Herdr host',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        sessionName: 'herdr-tab',
        terminalBackend: 'herdr',
        authToken: 'token-herdr',
        createdAt: 1,
      }],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(fetchTmuxSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({ terminalBackend: 'herdr' }),
      expect.any(Object),
    );
  });

  it('groups tabs by bridge target so the same target is only listed once', async () => {
    fetchTmuxSessionsMock
      .mockResolvedValueOnce(['alpha'])
      .mockResolvedValueOnce(['gamma']);

    const { filterRestorableOpenTabsByRemoteTmuxSessions } = await import('./open-tab-restore');

    const result = await filterRestorableOpenTabsByRemoteTmuxSessions({
      tabs: [
        {
          sessionId: 'tab-a1',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
        {
          sessionId: 'tab-a2',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'beta',
          authToken: 'token-a',
          createdAt: 2,
        },
        {
          sessionId: 'tab-b1',
          hostId: 'host-b',
          connectionName: 'Conn B',
          bridgeHost: '100.127.23.28',
          bridgePort: 3333,
          sessionName: 'gamma',
          authToken: 'token-b',
          createdAt: 3,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-a1', 'tab-a2', 'tab-b1']);
    expect(result.droppedTabs).toEqual([]);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(2);
  });

  it('groups tabs by daemonHostId owner and sends daemonHostId when restoring', async () => {
    fetchTmuxSessionsMock.mockResolvedValueOnce(['alpha', 'beta']);

    const { filterRestorableOpenTabsByRemoteTmuxSessions } = await import('./open-tab-restore');

    const result = await filterRestorableOpenTabsByRemoteTmuxSessions({
      tabs: [
        {
          sessionId: 'tab-a1',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-host-1',
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
        {
          sessionId: 'tab-a2',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.64.0.10',
          bridgePort: 4444,
          daemonHostId: 'daemon-host-1',
          sessionName: 'beta',
          authToken: 'token-a',
          createdAt: 2,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-a1', 'tab-a2']);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(1);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-host-1',
        relayHostId: 'daemon-host-1',
      }),
      expect.any(Object),
    );
  });

  it('does not collapse same endpoint tabs from different daemonHostId owners into one remote tmux truth query', async () => {
    fetchTmuxSessionsMock
      .mockResolvedValueOnce(['shared'])
      .mockResolvedValueOnce([]);

    const { filterRestorableOpenTabsByRemoteTmuxSessions } = await import('./open-tab-restore');

    const result = await filterRestorableOpenTabsByRemoteTmuxSessions({
      tabs: [
        {
          sessionId: 'tab-daemon-a',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          sessionName: 'shared',
          authToken: 'token-a',
          createdAt: 1,
        },
        {
          sessionId: 'tab-daemon-b',
          hostId: 'host-b',
          connectionName: 'Conn B',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          daemonHostId: 'daemon-b',
          sessionName: 'shared',
          authToken: 'token-b',
          createdAt: 2,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-daemon-a', 'tab-daemon-b']);
    expect(result.droppedTabs).toEqual([]);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(2);
    expect(fetchTmuxSessionsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        relayHostId: 'daemon-a',
      }),
      expect.any(Object),
    );
    expect(fetchTmuxSessionsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-b',
        relayHostId: 'daemon-b',
      }),
      expect.any(Object),
    );
  });

  it('upgrades a daemon-owned remote tmux truth query to the freshest saved host target for that owner', async () => {
    fetchTmuxSessionsMock.mockResolvedValueOnce(['shared']);

    const { fetchRemoteTmuxSessionNamesByOwner } = await import('./open-tab-restore');

    const result = await fetchRemoteTmuxSessionNamesByOwner({
      targets: [
        {
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          daemonHostId: 'daemon-a',
          authToken: 'token-stale',
        },
      ],
      hosts: [
        {
          daemonHostId: 'daemon-a',
          bridgeHost: '100.127.23.27',
          bridgePort: 4444,
          authToken: 'token-fresh',
          pinned: false,
          lastConnected: 99,
          createdAt: 1,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.get('daemon:daemon-a')).toEqual(['shared']);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(1);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        bridgeHost: '100.127.23.27',
        bridgePort: 4444,
        authToken: 'token-fresh',
        relayHostId: 'daemon-a',
      }),
      expect.any(Object),
    );
  });

  it('keeps separate daemon owners when multiple saved hosts share one endpoint', async () => {
    fetchTmuxSessionsMock
      .mockResolvedValueOnce(['alpha'])
      .mockResolvedValueOnce(['beta']);

    const { fetchRemoteTmuxSessionNamesByOwner } = await import('./open-tab-restore');

    const result = await fetchRemoteTmuxSessionNamesByOwner({
      targets: [
        {
          bridgeHost: 'relay.codewhisper.cc',
          bridgePort: 18443,
          daemonHostId: 'daemon-a',
          authToken: 'token-a-old',
        },
        {
          bridgeHost: 'relay.codewhisper.cc',
          bridgePort: 18443,
          daemonHostId: 'daemon-b',
          authToken: 'token-b-old',
        },
      ],
      hosts: [
        {
          daemonHostId: 'daemon-a',
          bridgeHost: 'relay.codewhisper.cc',
          bridgePort: 18443,
          authToken: 'token-a',
          pinned: false,
          lastConnected: 1,
          createdAt: 1,
        },
        {
          daemonHostId: 'daemon-b',
          bridgeHost: 'relay.codewhisper.cc',
          bridgePort: 18443,
          authToken: 'token-b',
          pinned: true,
          lastConnected: 99,
          createdAt: 2,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.get('daemon:daemon-a')).toEqual(['alpha']);
    expect(result.get('daemon:daemon-b')).toEqual(['beta']);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(2);
    expect(fetchTmuxSessionsMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
      }),
      expect.any(Object),
    );
    expect(fetchTmuxSessionsMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        daemonHostId: 'daemon-b',
        authToken: 'token-b',
      }),
      expect.any(Object),
    );
  });

  it('canonicalizes a stale target to the current unique endpoint host before remote tmux audit', async () => {
    fetchTmuxSessionsMock.mockResolvedValueOnce(['zterm']);

    const { fetchRemoteTmuxSessionNamesByOwner } = await import('./open-tab-restore');

    const result = await fetchRemoteTmuxSessionNamesByOwner({
      targets: [{
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-old',
        authToken: 'token-old',
      }],
      hosts: [
        {
          daemonHostId: 'daemon-new',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          authToken: 'token-new',
          pinned: true,
          lastConnected: 99,
          createdAt: 2,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.get('daemon:daemon-new')).toEqual(['zterm']);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(1);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        daemonHostId: 'daemon-new',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        authToken: 'token-new',
        relayHostId: 'daemon-new',
      }),
      expect.any(Object),
    );
  });

  it('uses an existing open mux target transport for remote tmux owner audit', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => ['zterm', 'alpha']);

    const { fetchRemoteTmuxSessionNamesByOwner } = await import('./open-tab-restore');

    const result = await fetchRemoteTmuxSessionNamesByOwner({
      targets: [{
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
      }],
      openSessions: [{
        id: 'live-session-a',
        state: 'connected',
        daemonHostId: 'daemon-a',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        createdAt: 10,
      }],
      prioritySessionIds: ['live-session-a'],
      manageTmuxSessionsOnOpenTransport,
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.get('daemon:daemon-a')).toEqual(['alpha', 'zterm']);
    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'live-session-a',
      { type: 'list-sessions' },
    );
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
  });

  it('does not fallback to legacy tmux fetch when a matching open target is not ready', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => null);

    const { fetchRemoteTmuxSessionNamesByOwner } = await import('./open-tab-restore');

    const result = await fetchRemoteTmuxSessionNamesByOwner({
      targets: [{
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
      }],
      openSessions: [{
        id: 'live-session-a',
        state: 'connecting',
        daemonHostId: 'daemon-a',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        createdAt: 10,
      }],
      prioritySessionIds: ['live-session-a'],
      manageTmuxSessionsOnOpenTransport,
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.get('daemon:daemon-a')).toEqual([]);
    expect(manageTmuxSessionsOnOpenTransport).toHaveBeenCalledWith(
      'live-session-a',
      { type: 'list-sessions' },
    );
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
  });

  it('does not fallback to legacy tmux fetch when existing open-target management fails', async () => {
    const manageTmuxSessionsOnOpenTransport = vi.fn(async () => {
      throw new Error('mux target request timeout');
    });

    const { fetchRemoteTmuxSessionNamesByOwner } = await import('./open-tab-restore');

    const result = await fetchRemoteTmuxSessionNamesByOwner({
      targets: [{
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        daemonHostId: 'daemon-a',
        authToken: 'token-a',
      }],
      openSessions: [{
        id: 'live-session-a',
        state: 'connected',
        daemonHostId: 'daemon-a',
        bridgeHost: '100.127.23.27',
        bridgePort: 3333,
        createdAt: 10,
      }],
      prioritySessionIds: ['live-session-a'],
      manageTmuxSessionsOnOpenTransport,
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.get('daemon:daemon-a')).toEqual([]);
    expect(fetchTmuxSessionsMock).not.toHaveBeenCalled();
  });

  it('resolves remote-restorable tab state with normalized active truth in one helper', async () => {
    fetchTmuxSessionsMock.mockResolvedValueOnce(['beta']);

    const { resolveRemoteRestorableOpenTabState } = await import('./open-tab-restore');

    const result = await resolveRemoteRestorableOpenTabState({
      tabs: [
        {
          sessionId: 'tab-a',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
        {
          sessionId: 'tab-b',
          hostId: 'host-b',
          connectionName: 'Conn B',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'beta',
          authToken: 'token-a',
          createdAt: 2,
        },
      ],
      activeSessionId: 'tab-a',
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.tabs.map((tab) => tab.sessionId)).toEqual(['tab-a', 'tab-b']);
    expect(result.activeSessionId).toBe('tab-a');
    expect(result.droppedTabs).toEqual([]);
  });

  it('keeps persisted tabs when remote tmux truth is unavailable (timeout/error)', async () => {
    fetchTmuxSessionsMock.mockRejectedValueOnce(new Error('timeout'));

    const { filterRestorableOpenTabsByRemoteTmuxSessions } = await import('./open-tab-restore');

    const result = await filterRestorableOpenTabsByRemoteTmuxSessions({
      tabs: [
        {
          sessionId: 'tab-a',
          hostId: 'host-a',
          connectionName: 'Conn A',
          bridgeHost: '100.127.23.27',
          bridgePort: 3333,
          sessionName: 'alpha',
          authToken: 'token-a',
          createdAt: 1,
        },
      ],
      bridgeSettings: {
        signalUrl: '',
        turnServerUrl: '',
        turnUsername: '',
        turnCredential: '',
        transportMode: 'auto',
        traversalRelay: undefined,
      },
    });

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-a']);
    expect(result.droppedTabs).toEqual([]);
  });

});
