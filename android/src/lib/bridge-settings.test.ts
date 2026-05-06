import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT, DEFAULT_TERMINAL_CACHE_LINES, WTERM_CONFIG_DISPLAY_PATH } from './mobile-config';
import {
  buildBridgeServerPresetIdentityId,
  buildDaemonStartCommand,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  normalizeBridgeSettings,
  removeBridgeServer,
  setDefaultBridgeServer,
  upsertBridgeServer,
} from './bridge-settings';

const baseSettings = {
  targetHost: '',
  targetPort: DEFAULT_BRIDGE_PORT,
  targetAuthToken: '',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto' as const,
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  terminalThemeId: 'classic-dark' as const,
  terminalWidthMode: 'mirror-fixed' as const,
  shortcutSmartSort: true,
  servers: [],
  traversalRelay: undefined,
};

describe('bridge-settings helpers', () => {
  it('builds daemon start command with configured port', () => {
    expect(buildDaemonStartCommand({ ...baseSettings, targetHost: '100.127.23.27', targetPort: 37283 })).toBe(
      `zterm-daemon start  # auth from ${WTERM_CONFIG_DISPLAY_PATH} (100.127.23.27:37283)`,
    );
  });

  it('formats target summary', () => {
    expect(formatBridgeTarget({ ...baseSettings, targetHost: '100.127.23.27', targetPort: 37283 })).toBe('100.127.23.27:37283');
  });

  it('keeps explicit websocket host as the endpoint truth', () => {
    const settings = upsertBridgeServer(baseSettings, {
      name: 'Mock Bridge',
      targetHost: 'ws://127.0.0.1:4333',
      targetPort: DEFAULT_BRIDGE_PORT,
    });

    expect(settings.targetPort).toBe(4333);
    expect(settings.defaultServerId).toBe('ws://127.0.0.1:4333');
    expect(formatBridgeTarget(settings)).toBe('ws://127.0.0.1:4333');
  });

  it('splits raw host:port into normalized host + effective port', () => {
    const settings = upsertBridgeServer(baseSettings, {
      name: 'Tailnet',
      targetHost: '100.127.23.27:40807',
      targetPort: DEFAULT_BRIDGE_PORT,
    });

    expect(settings.targetHost).toBe('100.127.23.27');
    expect(settings.targetPort).toBe(40807);
    expect(settings.defaultServerId).toBe('100.127.23.27:40807');
    expect(formatBridgeTarget(settings)).toBe('100.127.23.27:40807');
  });

  it('remembers bridge servers and can switch default', () => {
    const settings = upsertBridgeServer(
      baseSettings,
      { name: 'Tailscale', targetHost: '100.66.1.82', targetPort: DEFAULT_BRIDGE_PORT },
    );
    const withLan = upsertBridgeServer(settings, {
      name: 'LAN',
      targetHost: '192.168.0.130',
      targetPort: DEFAULT_BRIDGE_PORT,
    });

    expect(withLan.servers).toHaveLength(2);

    const switched = setDefaultBridgeServer(withLan, `192.168.0.130:${DEFAULT_BRIDGE_PORT}`);
    expect(switched.targetHost).toBe('192.168.0.130');
    expect(switched.defaultServerId).toBe(`192.168.0.130:${DEFAULT_BRIDGE_PORT}`);
  });

  it('keeps different daemonHostId presets separate even when bridge endpoint matches', () => {
    const settings = upsertBridgeServer(
      upsertBridgeServer(baseSettings, {
        name: 'Daemon A',
        targetHost: '100.127.23.27',
        targetPort: 40807,
        relayHostId: 'daemon-a',
      }),
      {
        name: 'Daemon B',
        targetHost: '100.127.23.27',
        targetPort: 40807,
        relayHostId: 'daemon-b',
      },
    );

    expect(settings.servers).toHaveLength(2);
    expect(settings.servers.map((server) => server.id).sort()).toEqual([
      buildBridgeServerPresetIdentityId('100.127.23.27', 40807, 'daemon-a'),
      buildBridgeServerPresetIdentityId('100.127.23.27', 40807, 'daemon-b'),
    ]);
  });

  it('removing the default entry point re-points default to the next preset', () => {
    const settings = upsertBridgeServer(
      upsertBridgeServer(baseSettings, {
        name: 'Tailscale',
        targetHost: '100.66.1.82',
        targetPort: DEFAULT_BRIDGE_PORT,
        authToken: 'token-ts',
      }),
      {
        name: 'LAN',
        targetHost: '192.168.0.130',
        targetPort: DEFAULT_BRIDGE_PORT,
        authToken: 'token-lan',
      },
    );

    const removed = removeBridgeServer(settings, `100.66.1.82:${DEFAULT_BRIDGE_PORT}`);

    expect(removed.defaultServerId).toBe(`192.168.0.130:${DEFAULT_BRIDGE_PORT}`);
    expect(removed.targetHost).toBe('192.168.0.130');
    expect(removed.targetAuthToken).toBe('token-lan');
  });

  it('removing the last entry point clears the effective target instead of silently keeping stale values', () => {
    const settings = upsertBridgeServer(baseSettings, {
      name: 'Tailscale',
      targetHost: '100.66.1.82',
      targetPort: DEFAULT_BRIDGE_PORT,
      authToken: 'token-ts',
    });

    const removed = removeBridgeServer(settings, `100.66.1.82:${DEFAULT_BRIDGE_PORT}`);

    expect(removed.servers).toEqual([]);
    expect(removed.defaultServerId).toBeUndefined();
    expect(removed.targetHost).toBe('');
    expect(removed.targetAuthToken).toBe('');
  });

  it('normalizes terminal theme id and uses default for unknown values', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalThemeId: 'tabby-relaxed',
    }).terminalThemeId).toBe('tabby-relaxed');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalThemeId: 'unknown-theme',
    }).terminalThemeId).toBe('classic-dark');
  });

  it('clamps terminal cache lines to the client max 1000', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalCacheLines: 5000,
    }).terminalCacheLines).toBe(DEFAULT_TERMINAL_CACHE_LINES);
  });

  it('normalizes terminal width mode and defaults to mirror-fixed', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalWidthMode: 'adaptive-phone',
    }).terminalWidthMode).toBe('adaptive-phone');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalWidthMode: 'unknown-mode',
    }).terminalWidthMode).toBe('mirror-fixed');
  });

  it('describes preset identity as bridge entrypoint plus optional daemon identity', () => {
    expect(
      describeBridgePresetIdentity({
        targetHost: '100.127.23.27',
        targetPort: 40807,
        relayHostId: 'daemon-host-a',
      }),
    ).toEqual({
      daemonHostId: 'daemon-host-a',
      bridgeLabel: 'Bridge · 100.127.23.27:40807',
      daemonLabel: 'Daemon · daemon-host-a',
    });
  });

  it('migrates a legacy defaultServerId keyed only by endpoint to the unique daemon-aware preset id when unambiguous', () => {
    const settings = normalizeBridgeSettings({
      ...baseSettings,
      targetHost: '100.127.23.27',
      targetPort: 40807,
      defaultServerId: '100.127.23.27:40807',
      servers: [
        {
          id: '100.127.23.27:40807',
          name: 'Daemon A',
          targetHost: '100.127.23.27',
          targetPort: 40807,
          relayHostId: 'daemon-a',
        },
      ],
    });

    expect(settings.defaultServerId).toBe(
      buildBridgeServerPresetIdentityId('100.127.23.27', 40807, 'daemon-a'),
    );
  });
});
