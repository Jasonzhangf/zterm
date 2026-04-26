export const MOBILE_BRIDGE_CONFIG = {
  defaultBridgePort: 3333,
  daemonHost: '0.0.0.0',
  defaultTerminalCacheLines: 1000,
} as const;

export const DEFAULT_BRIDGE_PORT = MOBILE_BRIDGE_CONFIG.defaultBridgePort;
export const DEFAULT_DAEMON_HOST = MOBILE_BRIDGE_CONFIG.daemonHost;
export const DEFAULT_DAEMON_PORT = MOBILE_BRIDGE_CONFIG.defaultBridgePort;
export const DEFAULT_TERMINAL_CACHE_LINES = MOBILE_BRIDGE_CONFIG.defaultTerminalCacheLines;
export const WTERM_CONFIG_DISPLAY_PATH = '~/.wterm/config.json';

export function buildDaemonSessionName(port: number = DEFAULT_DAEMON_PORT) {
  return `zterm-daemon-${port}`;
}

export const DEFAULT_DAEMON_SESSION_NAME = buildDaemonSessionName();
export const BRIDGE_URL_PLACEHOLDER = `ws://host:${DEFAULT_BRIDGE_PORT}`;
export const TERMINAL_CACHE_SCREENS = 3;
export const ACTIVE_HEAD_REFRESH_TICK_MS = 33;

export interface TerminalRefreshCadence {
  headTickMs: number;
  minTailRefreshGapMs: number;
  headStalePingMs: number;
  readingSyncDelayMs: number;
}

function readEffectiveNetworkProfile() {
  if (typeof navigator === 'undefined') {
    return {
      effectiveType: '',
      saveData: false,
    };
  }

  const connection =
    (navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean };
      mozConnection?: { effectiveType?: string; saveData?: boolean };
      webkitConnection?: { effectiveType?: string; saveData?: boolean };
    }).connection
    || (navigator as Navigator & { mozConnection?: { effectiveType?: string; saveData?: boolean } }).mozConnection
    || (navigator as Navigator & { webkitConnection?: { effectiveType?: string; saveData?: boolean } }).webkitConnection
    || null;

  return {
    effectiveType: String(connection?.effectiveType || '').toLowerCase(),
    saveData: Boolean(connection?.saveData),
  };
}

export function resolveTerminalRefreshCadence(): TerminalRefreshCadence {
  const network = readEffectiveNetworkProfile();

  if (network.saveData || network.effectiveType === 'slow-2g' || network.effectiveType === '2g') {
    return {
      headTickMs: ACTIVE_HEAD_REFRESH_TICK_MS,
      minTailRefreshGapMs: 120,
      headStalePingMs: 520,
      readingSyncDelayMs: 72,
    };
  }

  if (network.effectiveType === '3g') {
    return {
      headTickMs: ACTIVE_HEAD_REFRESH_TICK_MS,
      minTailRefreshGapMs: 66,
      headStalePingMs: 320,
      readingSyncDelayMs: 48,
    };
  }

  return {
    headTickMs: ACTIVE_HEAD_REFRESH_TICK_MS,
    minTailRefreshGapMs: ACTIVE_HEAD_REFRESH_TICK_MS,
    headStalePingMs: 200,
    readingSyncDelayMs: 24,
  };
}

export function withDefaultBridgePort(port?: number | null) {
  return port || DEFAULT_BRIDGE_PORT;
}

export function resolveTerminalRequestWindowLines(rows?: number | null) {
  const viewportRows =
    typeof rows === 'number' && Number.isFinite(rows)
      ? Math.max(1, Math.floor(rows))
      : 24;
  return viewportRows * TERMINAL_CACHE_SCREENS;
}
