import { describe, expect, it } from 'vitest';
import { DEFAULT_BRIDGE_PORT, DEFAULT_TERMINAL_CACHE_LINES, WTERM_CONFIG_DISPLAY_PATH } from './mobile-config';
import { buildDaemonStartCommand, formatBridgeTarget, setDefaultBridgeServer, upsertBridgeServer } from './bridge-settings';

const baseSettings = {
  targetHost: '',
  targetPort: DEFAULT_BRIDGE_PORT,
  terminalCacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  servers: [],
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
});
