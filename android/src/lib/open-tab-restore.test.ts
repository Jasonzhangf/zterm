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

  it('filters out persisted tabs whose tmux session no longer exists remotely', async () => {
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

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-b']);
    expect(result.droppedTabs.map((tab) => tab.sessionId)).toEqual(['tab-a']);
    expect(fetchTmuxSessionsMock).toHaveBeenCalledTimes(1);
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

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-a1', 'tab-b1']);
    expect(result.droppedTabs.map((tab) => tab.sessionId)).toEqual(['tab-a2']);
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

    expect(result.restorableTabs.map((tab) => tab.sessionId)).toEqual(['tab-daemon-a']);
    expect(result.droppedTabs.map((tab) => tab.sessionId)).toEqual(['tab-daemon-b']);
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

    expect(result.tabs.map((tab) => tab.sessionId)).toEqual(['tab-b']);
    expect(result.activeSessionId).toBe('tab-b');
    expect(result.droppedTabs.map((tab) => tab.sessionId)).toEqual(['tab-a']);
  });
});
