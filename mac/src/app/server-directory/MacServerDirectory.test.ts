import { describe, expect, it } from 'vitest';
import {
  buildBridgeServerPresetIdentityId,
  type BridgeSettings,
  type Host,
} from '@zterm/shared';
import {
  buildMacServerDirectorySessionKey,
  fetchMacServerDirectoryLiveSessionSnapshot,
  projectMacServerDirectory,
  resolveMacServerDirectoryOpenIntent,
} from './MacServerDirectory';

function makeSettings(): BridgeSettings {
  return {
    targetHost: '127.0.0.1',
    targetPort: 3333,
    targetAuthToken: 'token-a',
    signalUrl: '',
    turnServerUrl: '',
    turnUsername: '',
    turnCredential: '',
    transportMode: 'auto',
    terminalCacheLines: 2000,
    terminalThemeId: 'default',
    terminalWidthMode: 'mirror-fixed',
    shortcutSmartSort: true,
    defaultServerId: buildBridgeServerPresetIdentityId('127.0.0.1', 3333),
    servers: [
      {
        id: buildBridgeServerPresetIdentityId('127.0.0.1', 3333),
        name: 'Local daemon',
        targetHost: '127.0.0.1',
        targetPort: 3333,
        authToken: 'token-a',
      },
    ],
  } as BridgeSettings;
}

function makeHost(id: string, sessionName: string): Host {
  return {
    id,
    createdAt: 1,
    name: sessionName,
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName,
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
  };
}

describe('MacServerDirectory projection', () => {
  it('groups saved hosts under shared server identity', () => {
    const projection = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [makeHost('h-a', 'alpha'), makeHost('h-b', 'beta')],
    });

    expect(projection.servers).toHaveLength(1);
    expect(projection.servers[0].name).toBe('Local daemon');
    expect(projection.servers[0].sessions.map((session) => session.sessionName)).toEqual(['alpha', 'beta']);
    expect(projection.servers[0].sessions.every((session) => session.source === 'saved-host')).toBe(true);
  });

  it('projects live sessions under the owning server without requiring saved hosts', () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    const projection = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [],
      liveSessions: [{ serverId, sessionNames: ['zterm_mac_goal_a', 'zterm_mac_goal_b'] }],
    });

    expect(projection.servers[0].sessions.map((session) => session.sessionName)).toEqual([
      'zterm_mac_goal_a',
      'zterm_mac_goal_b',
    ]);
    expect(projection.servers[0].sessions.every((session) => session.source === 'live')).toBe(true);
  });

  it('marks open sessions from explicit workspace keys but does not create or close tabs', () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    const projection = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [makeHost('h-a', 'alpha')],
      liveSessions: [{ serverId, sessionNames: ['alpha', 'missing-from-hosts'] }],
      openSessionKeys: [buildMacServerDirectorySessionKey(serverId, 'alpha')],
    });

    const sessions = projection.servers[0].sessions;
    expect(sessions.find((session) => session.sessionName === 'alpha')?.isOpen).toBe(true);
    expect(sessions.find((session) => session.sessionName === 'missing-from-hosts')?.isOpen).toBe(false);
    expect(sessions.map((session) => session.sessionName)).toContain('missing-from-hosts');
  });

  it('refresh projection changes live sessions only and keeps already open unavailable sessions visible from saved hosts', () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    const first = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [makeHost('h-a', 'alpha')],
      liveSessions: [{ serverId, sessionNames: ['alpha'] }],
      openSessionKeys: [buildMacServerDirectorySessionKey(serverId, 'alpha')],
    });
    const refreshed = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [makeHost('h-a', 'alpha')],
      liveSessions: [{ serverId, sessionNames: [] }],
      openSessionKeys: [buildMacServerDirectorySessionKey(serverId, 'alpha')],
    });

    expect(first.servers[0].sessions.find((session) => session.sessionName === 'alpha')?.isOpen).toBe(true);
    expect(refreshed.servers[0].sessions.find((session) => session.sessionName === 'alpha')?.isOpen).toBe(true);
    expect(refreshed.servers[0].sessions.find((session) => session.sessionName === 'alpha')?.source).toBe('saved-host');
  });

  it('deduplicates duplicate endpoint aliases to one server identity', () => {
    const settings = makeSettings();
    const projection = projectMacServerDirectory({
      bridgeSettings: {
        ...settings,
        servers: [
          settings.servers[0],
          {
            id: buildBridgeServerPresetIdentityId('127.0.0.1', 3333),
            name: 'Duplicate local',
            targetHost: '127.0.0.1',
            targetPort: 3333,
          },
        ],
      },
      hosts: [makeHost('h-a', 'alpha')],
    });

    expect(projection.servers).toHaveLength(1);
    expect(projection.servers[0].sessions.map((session) => session.sessionName)).toEqual(['alpha']);
  });

  it('builds explicit open intents without mutating the projection', () => {
    const projection = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [makeHost('h-a', 'alpha')],
    });
    const before = JSON.stringify(projection);
    const intent = resolveMacServerDirectoryOpenIntent(projection, projection.servers[0].id, 'alpha');

    expect(intent).toMatchObject({
      serverId: projection.servers[0].id,
      sessionName: 'alpha',
      persistedHostId: 'h-a',
      target: {
        bridgeHost: '127.0.0.1',
        bridgePort: 3333,
        sessionName: 'alpha',
        authToken: 'token-a',
      },
    });
    expect(JSON.stringify(projection)).toBe(before);
  });

  it('throws explicit errors for unknown server open intents', () => {
    const projection = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [],
    });

    expect(() => resolveMacServerDirectoryOpenIntent(projection, 'missing', 'alpha')).toThrow('Unknown Mac server');
  });

  it('projects refresh status and error without dropping saved/open sessions', () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    const projection = projectMacServerDirectory({
      bridgeSettings: makeSettings(),
      hosts: [makeHost('h-a', 'alpha')],
      liveSessions: [{ serverId, sessionNames: [] }],
      openSessionKeys: [buildMacServerDirectorySessionKey(serverId, 'alpha')],
      refreshStates: {
        [serverId]: {
          status: 'error',
          error: 'daemon refused list-sessions',
          refreshedAt: 123,
        },
      },
    });

    expect(projection.servers[0].refreshState).toMatchObject({
      status: 'error',
      error: 'daemon refused list-sessions',
      refreshedAt: 123,
    });
    expect(projection.servers[0].sessions.map((session) => session.sessionName)).toEqual(['alpha']);
    expect(projection.servers[0].sessions[0].isOpen).toBe(true);
  });

  it('fetches one server live session snapshot through the injected daemon session fetcher', async () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    const snapshot = await fetchMacServerDirectoryLiveSessionSnapshot(
      {
        id: serverId,
        name: 'Local daemon',
        endpointLabel: '127.0.0.1:3333',
        daemonLabel: '127.0.0.1',
        targetHost: '127.0.0.1',
        targetPort: 3333,
        authToken: 'token-a',
        sessions: [],
      },
      async (target) => {
        expect(target).toEqual({
          bridgeHost: '127.0.0.1',
          bridgePort: 3333,
          authToken: 'token-a',
        });
        return ['beta', 'alpha', 'alpha', '   '];
      },
    );

    expect(snapshot).toEqual({
      serverId,
      sessionNames: ['alpha', 'beta'],
    });
  });

  it('fails refresh explicitly when a server target has no auth token', async () => {
    const serverId = buildBridgeServerPresetIdentityId('127.0.0.1', 3333);
    await expect(fetchMacServerDirectoryLiveSessionSnapshot(
      {
        id: serverId,
        name: 'Local daemon',
        endpointLabel: '127.0.0.1:3333',
        daemonLabel: '127.0.0.1',
        targetHost: '127.0.0.1',
        targetPort: 3333,
        sessions: [],
      },
      async () => ['alpha'],
    )).rejects.toMatchObject({ message: expect.stringContaining('auth token') });
  });
});
