import { describe, expect, it } from 'vitest';
import { extractApkSmokeBridgeDebugTargetFromStorageDump } from './android-apk-smoke-device-bridge-target';

describe('android apk smoke device bridge target parser', () => {
  it('prefers the active open tab target from localStorage dump truth', () => {
    const parsed = extractApkSmokeBridgeDebugTargetFromStorageDump([
      'random-prefix zterm:active-session',
      'session-live-2',
      'zterm:open-tabs',
      JSON.stringify([
        {
          sessionId: 'session-live-1',
          bridgeHost: '100.66.1.81',
          bridgePort: 3333,
          authToken: 'token-a',
          sessionName: 'main',
        },
        {
          sessionId: 'session-live-2',
          bridgeHost: '100.66.1.82',
          bridgePort: 4444,
          authToken: 'token-b',
          sessionName: 'logs',
          daemonHostId: 'daemon-b',
        },
      ]),
    ].join('\n'));

    expect(parsed.activeSessionId).toBe('session-live-2');
    expect(parsed.target).toEqual(expect.objectContaining({
      source: 'active-open-tab',
      bridgeHost: '100.66.1.82',
      bridgePort: 4444,
      authToken: 'token-b',
      sessionId: 'session-live-2',
      daemonHostId: 'daemon-b',
    }));
  });

  it('falls back to bridge settings default server when no active open tab is present', () => {
    const parsed = extractApkSmokeBridgeDebugTargetFromStorageDump([
      'zterm:bridge-settings',
      JSON.stringify({
        targetHost: '',
        targetPort: 3333,
        targetAuthToken: '',
        servers: [
          {
            id: 'preset-1',
            name: 'Tailscale',
            targetHost: '100.66.1.90',
            targetPort: 3333,
            authToken: 'token-server',
            relayHostId: 'daemon-ts',
          },
        ],
        defaultServerId: 'preset-1',
      }),
    ].join('\n'));

    expect(parsed.target).toEqual(expect.objectContaining({
      source: 'bridge-settings-server',
      bridgeHost: '100.66.1.90',
      bridgePort: 3333,
      authToken: 'token-server',
      daemonHostId: 'daemon-ts',
    }));
  });

  it('extracts bridge target from fragmented WebView LevelDB open-tab truth', () => {
    const parsed = extractApkSmokeBridgeDebugTargetFromStorageDump([
      'zterm:active-sessiondR',
      'l-1778548350941-m0zaq5ut(',
      '_RV)D35242-gfbyoilv(',
      ']R)L4465921-yq0l9dr6(',
      '[)',
      '_http://localhost',
      'zterm:open-tabs7R',
      '[{"sessionId":',
      'd-1778544465921-yq0l9dr6","N*',
      '1b74bfc3-0e73-4b34-a4fb-bdd312dcf0bf","connectionName":"100.66.1.82  demo-route-shell","bridgeHost":"100.66.1.82","bridgePort":3333,"daemonHostId":"daemon-Macstudio.l!<-128564413166185',
      's',
      'r>',
      '0authToken":"w!9-412345!lautoCommand":"","createdAt":!6,493887470},{h%1',
    ].join('\n'));

    expect(parsed.target).toEqual(expect.objectContaining({
      source: 'open-tab',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      authToken: 'w!9-412345!l',
      sessionId: 'session-1778544465921-yq0l9dr6',
    }));
  });

  it('keeps fragmented open-tab host/port but falls back to bridge-settings auth token when open-tab token is binary-polluted', () => {
    const parsed = extractApkSmokeBridgeDebugTargetFromStorageDump([
      'bridge-settings',
      ':l{"targetHost":"100.66.1.82",',
      '$Port":3333',
      '0AuthToken":"wterm-4123456","xCacheLines":3000}',
      '_http://localhost',
      'zterm:open-tabs7R',
      '[{"sessionId":',
      'd-1778544465921-yq0l9dr6","N*',
      '1b74bfc3-0e73-4b34-a4fb-bdd312dcf0bf","connectionName":"100.66.1.82  demo-route-shell","bridgeHost":"100.66.1.82","bridgePort":3333,"daemonHostId":"daemon-Macstudio.local-128564413166185f",',
      '0authToken":"w!9-412345!lautoCommand":"","createdAt":1778544465921',
    ].join('\n'));

    expect(parsed.target).toEqual(expect.objectContaining({
      source: 'open-tab',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      authToken: 'wterm-4123456',
      sessionId: 'session-1778544465921-yq0l9dr6',
    }));
  });

  it('does not resurrect stale fragmented open tabs when current open-tabs truth is empty', () => {
    const parsed = extractApkSmokeBridgeDebugTargetFromStorageDump([
      'zterm:active-session',
      "session-1782952800836-0hoooloi'_http://localhost",
      '_http://localhost',
      'zterm:open-tabs7R',
      '[{"sessionId":',
      'd-1778544465921-yq0l9dr6","bridgeHost":"100.66.1.82","bridgePort":3333,"authToken":"old-token","sessionName":"old"}',
      'bridge-settings',
      ':l{"targetHost":"100.66.1.82",',
      '$Port":3333',
      '0AuthToken":"wterm-4123456","xCacheLines":3000}',
      '_http://localhost',
      'zterm:open-tabs',
      'T[]',
    ].join('\n'));

    expect(parsed.activeSessionId).toBeNull();
    expect(parsed.target).toEqual(expect.objectContaining({
      source: 'bridge-settings-target',
      bridgeHost: '100.66.1.82',
      bridgePort: 3333,
      authToken: 'wterm-4123456',
    }));
    expect(parsed.target).not.toEqual(expect.objectContaining({
      sessionId: 'session-1778544465921-yq0l9dr6',
    }));
  });

  it('returns null when no bridge-like payload exists in the dump', () => {
    const parsed = extractApkSmokeBridgeDebugTargetFromStorageDump('hello\nworld\nno json here');
    expect(parsed.activeSessionId).toBeNull();
    expect(parsed.target).toBeNull();
  });
});
