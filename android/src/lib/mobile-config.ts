export const MOBILE_BRIDGE_CONFIG = {
  defaultBridgePort: 3333,
  daemonHost: '0.0.0.0',
  defaultTerminalCacheLines: 72,
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

export function withDefaultBridgePort(port?: number | null) {
  return port || DEFAULT_BRIDGE_PORT;
}

export function resolveTerminalCacheLines(rows?: number | null) {
  const viewportRows =
    typeof rows === 'number' && Number.isFinite(rows)
      ? Math.max(1, Math.floor(rows))
      : 24;
  return viewportRows * TERMINAL_CACHE_SCREENS;
}
