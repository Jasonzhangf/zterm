import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT, DEFAULT_TERMINAL_CACHE_LINES, WTERM_CONFIG_DISPLAY_PATH } from './mobile-config';
import {
  buildBridgeServerPresetIdentityId,
  buildDaemonStartCommand,
  describeBridgePresetIdentity,
  formatBridgeTarget,
  normalizeBridgeSettings,
  resolveTerminalFontSizePx,
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
  terminalShellSkin: 'light' as const,
  terminalFontSize: 'minimum' as const,
  terminalWidthMode: 'mirror-fixed' as const,
  terminalSessionGroupLayoutMode: 'auto' as const,
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

  it('normalizes and resolves terminal font sizes', () => {
    expect(normalizeBridgeSettings({ ...baseSettings }).terminalFontSize).toBe('minimum');
    expect(normalizeBridgeSettings({ ...baseSettings, terminalFontSize: 'large' }).terminalFontSize).toBe('large');
    expect(normalizeBridgeSettings({ ...baseSettings, terminalFontSize: 'invalid' }).terminalFontSize).toBe('minimum');
    expect(resolveTerminalFontSizePx('minimum')).toBe(10);
    expect(resolveTerminalFontSizePx('small')).toBe(12);
    expect(resolveTerminalFontSizePx('medium')).toBe(14);
    expect(resolveTerminalFontSizePx('large')).toBe(16);
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

  it('reuses one daemon entity when its endpoint changes and repairs an endpoint-only name', () => {
    const first = upsertBridgeServer(baseSettings, {
      name: '192.168.0.3',
      targetHost: '192.168.0.3',
      targetPort: DEFAULT_BRIDGE_PORT,
      authToken: 'token-a',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-a',
      relayDeviceName: 'Mac Studio',
    });
    const second = upsertBridgeServer(first, {
      name: '100.64.0.10',
      targetHost: '100.64.0.10',
      targetPort: DEFAULT_BRIDGE_PORT,
      authToken: 'token-a',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-a',
      relayDeviceName: 'Mac Studio',
    });

    expect(second.servers).toHaveLength(1);
    expect(second.servers[0]).toMatchObject({
      id: first.servers[0]!.id,
      name: 'Mac Studio',
      targetHost: '100.64.0.10',
      relayHostId: 'mac-studio',
      relayDeviceId: 'device-a',
    });
  });

  it('canonicalizes legacy endpoint-split presets into one daemon entity', () => {
    const canonical = buildBridgeServerPresetIdentityId('100.64.0.10', 3333, 'mac-studio');
    const settings = normalizeBridgeSettings({
      ...baseSettings,
      servers: [
        {
          id: buildBridgeServerPresetIdentityId('192.168.0.3', 3333, 'mac-studio'),
          name: '192.168.0.3',
          targetHost: '192.168.0.3',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'mac-studio',
          relayDeviceId: 'device-a',
          relayDeviceName: 'Mac Studio',
        },
        {
          id: canonical,
          name: 'Mac Studio',
          targetHost: '100.64.0.10',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'mac-studio',
          relayDeviceId: 'device-a',
          relayDeviceName: 'Mac Studio',
        },
      ],
    });

    expect(settings.servers).toHaveLength(1);
    expect(settings.servers[0]).toMatchObject({ id: canonical, name: 'Mac Studio' });
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

  it('normalizes terminal shell skin and defaults old values to auto', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalShellSkin: 'auto',
    }).terminalShellSkin).toBe('auto');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalShellSkin: 'light',
    }).terminalShellSkin).toBe('light');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalShellSkin: 'black',
    }).terminalShellSkin).toBe('black');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalShellSkin: 'blue',
    }).terminalShellSkin).toBe('blue');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalShellSkin: 'unknown-skin' as any,
    }).terminalShellSkin).toBe('auto');

    const { terminalShellSkin: _terminalShellSkin, ...legacySettings } = baseSettings;
    expect(normalizeBridgeSettings(legacySettings).terminalShellSkin).toBe('auto');
  });

  it('clamps terminal cache lines to the client max 1000', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalCacheLines: 5000,
    }).terminalCacheLines).toBe(DEFAULT_TERMINAL_CACHE_LINES);
  });

  it('normalizes terminal width mode and defaults unknown values to adaptive-phone', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalWidthMode: 'adaptive-phone',
    }).terminalWidthMode).toBe('adaptive-phone');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalWidthMode: 'mirror-fixed',
    }).terminalWidthMode).toBe('mirror-fixed');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalWidthMode: 'unknown-mode',
    }).terminalWidthMode).toBe('adaptive-phone');
  });

  it('normalizes session group layout mode and defaults to auto', () => {
    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalSessionGroupLayoutMode: 'horizontal',
    }).terminalSessionGroupLayoutMode).toBe('horizontal');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalSessionGroupLayoutMode: 'vertical',
    }).terminalSessionGroupLayoutMode).toBe('vertical');

    expect(normalizeBridgeSettings({
      ...baseSettings,
      terminalSessionGroupLayoutMode: 'unknown-mode' as any,
    }).terminalSessionGroupLayoutMode).toBe('auto');
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

  it('migrates one stale daemon preset to the unique device-backed canonical preset', () => {
    const staleId = buildBridgeServerPresetIdentityId('10.0.2.2', 3333, 'daemon-old');
    const canonicalId = buildBridgeServerPresetIdentityId('192.168.0.3', 3333, 'mac-studio');
    const settings = normalizeBridgeSettings({
      ...baseSettings,
      targetHost: '192.168.0.3',
      targetPort: 3333,
      targetAuthToken: 'token-a',
      defaultServerId: staleId,
      servers: [
        {
          id: staleId,
          name: 'Emulator bridge',
          targetHost: '10.0.2.2',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'daemon-old',
        },
        {
          id: canonicalId,
          name: 'Mac Studio',
          targetHost: '192.168.0.3',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'mac-studio',
          relayDeviceId: 'mac-studio',
        },
      ],
    });

    expect(settings.servers).toEqual([
      expect.objectContaining({
        id: canonicalId,
        targetHost: '192.168.0.3',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio',
      }),
    ]);
    expect(settings.defaultServerId).toBe(canonicalId);
  });

  it('migrates an upserted stale preset to the canonical device-backed daemon identity', () => {
    const stale = upsertBridgeServer(baseSettings, {
      name: 'Emulator bridge',
      targetHost: '10.0.2.2',
      targetPort: 3333,
      authToken: 'token-a',
      relayHostId: 'daemon-old',
    });
    const canonical = upsertBridgeServer(stale, {
      name: 'Mac Studio',
      targetHost: '192.168.0.3',
      targetPort: 3333,
      authToken: 'token-a',
      relayHostId: 'mac-studio',
      relayDeviceId: 'mac-studio',
    });

    expect(canonical.servers).toEqual([
      expect.objectContaining({
        targetHost: '192.168.0.3',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio',
      }),
    ]);
    expect(canonical.defaultServerId).toBe(
      buildBridgeServerPresetIdentityId('192.168.0.3', 3333, 'mac-studio'),
    );
  });

  it('uses a self-named relay device host as the canonical identity for duplicate device registrations', () => {
    const settings = normalizeBridgeSettings({
      ...baseSettings,
      targetHost: '192.168.0.3',
      targetPort: 3333,
      targetAuthToken: 'token-a',
      servers: [
        {
          id: buildBridgeServerPresetIdentityId('10.0.2.2', 3333, 'daemon-old'),
          name: 'Stale identity',
          targetHost: '10.0.2.2',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'daemon-old',
          relayDeviceId: 'mac-studio',
        },
        {
          id: buildBridgeServerPresetIdentityId('192.168.0.3', 3333, 'mac-studio'),
          name: 'Canonical identity',
          targetHost: '192.168.0.3',
          targetPort: 3333,
          authToken: 'token-a',
          relayHostId: 'mac-studio',
          relayDeviceId: 'mac-studio',
        },
      ],
    });

    expect(settings.servers).toEqual([
      expect.objectContaining({
        targetHost: '192.168.0.3',
        relayHostId: 'mac-studio',
        relayDeviceId: 'mac-studio',
      }),
    ]);
  });

  it('does not merge different relay devices that share one daemon auth token', () => {
    const settings = normalizeBridgeSettings({
      ...baseSettings,
      servers: [
        {
          id: buildBridgeServerPresetIdentityId('192.168.0.3', 3333, 'daemon-a'),
          name: 'Daemon A',
          targetHost: '192.168.0.3',
          targetPort: 3333,
          authToken: 'shared-token',
          relayHostId: 'daemon-a',
          relayDeviceId: 'device-a',
        },
        {
          id: buildBridgeServerPresetIdentityId('192.168.0.4', 3333, 'daemon-b'),
          name: 'Daemon B',
          targetHost: '192.168.0.4',
          targetPort: 3333,
          authToken: 'shared-token',
          relayHostId: 'daemon-b',
          relayDeviceId: 'device-b',
        },
      ],
    });

    expect(settings.servers.map((server) => server.relayHostId).sort()).toEqual([
      'daemon-a',
      'daemon-b',
    ]);
  });
});
