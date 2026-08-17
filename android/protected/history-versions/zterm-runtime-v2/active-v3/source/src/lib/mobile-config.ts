export const MOBILE_BRIDGE_CONFIG = {
  defaultBridgePort: 3333,
  daemonHost: '0.0.0.0',
  defaultTerminalCacheLines: 1000,
} as const;

export const DEFAULT_BRIDGE_PORT = MOBILE_BRIDGE_CONFIG.defaultBridgePort;
export const DEFAULT_DAEMON_HOST = MOBILE_BRIDGE_CONFIG.daemonHost;
export const DEFAULT_DAEMON_PORT = MOBILE_BRIDGE_CONFIG.defaultBridgePort;
export const DEFAULT_TERMINAL_CACHE_LINES = MOBILE_BRIDGE_CONFIG.defaultTerminalCacheLines;
export const WTERM_CONFIG_DISPLAY_PATH = '~/.zterm/config.json';

export function buildDaemonSessionName(port: number = DEFAULT_DAEMON_PORT) {
  return `zterm-daemon-${port}`;
}

export const DEFAULT_DAEMON_SESSION_NAME = buildDaemonSessionName();
export const BRIDGE_URL_PLACEHOLDER = `ws://host:${DEFAULT_BRIDGE_PORT}`;
import { resolveTerminalRequestWindowLines as sharedResolveRequestWindowLines } from '@zterm/shared/terminal/viewport-utils';

export const TERMINAL_CACHE_SCREENS = 3;
export const ACTIVE_HEAD_REFRESH_TICK_MS = 33;

export interface TerminalRefreshCadence {
  headTickMs: number;
  minTailRefreshGapMs: number;
  headStalePingMs: number;
  pullRequestStaleMs: number;
  readingSyncDelayMs: number;
}

export interface TerminalRefreshCadenceOptions {
  runtimeTransport?: {
    rttMs?: number;
    bufferedBytes?: number;
    backpressure?: boolean;
    recentPayloadBytes?: number;
    hasRecentProgress?: boolean;
  } | null;
}

function readEffectiveNetworkProfile(): { effectiveType: string; saveData: boolean; rttMs: number } {
  if (typeof navigator === 'undefined') {
    return {
      effectiveType: '',
      saveData: false,
      rttMs: 0,
    };
  }

  const connection =
    (navigator as Navigator & {
      connection?: { effectiveType?: string; saveData?: boolean; rtt?: number };
      mozConnection?: { effectiveType?: string; saveData?: boolean; rtt?: number };
      webkitConnection?: { effectiveType?: string; saveData?: boolean; rtt?: number };
    }).connection
    || (navigator as Navigator & { mozConnection?: { effectiveType?: string; saveData?: boolean; rtt?: number } }).mozConnection
    || (navigator as Navigator & { webkitConnection?: { effectiveType?: string; saveData?: boolean; rtt?: number } }).webkitConnection
    || null;

  return {
    effectiveType: String(connection?.effectiveType || '').toLowerCase(),
    saveData: Boolean(connection?.saveData),
    rttMs: Number.isFinite(connection?.rtt) ? Math.max(0, Math.floor(connection?.rtt || 0)) : 0,
  };
}

export function resolveTerminalRefreshCadence(options?: TerminalRefreshCadenceOptions): TerminalRefreshCadence {
  const network = readEffectiveNetworkProfile();
  const runtimeTransport = options?.runtimeTransport || null;
  const runtimeRttMs = Number.isFinite(runtimeTransport?.rttMs)
    ? Math.max(0, Math.floor(runtimeTransport?.rttMs || 0))
    : 0;
  const runtimeBufferedBytes = Number.isFinite(runtimeTransport?.bufferedBytes)
    ? Math.max(0, Math.floor(runtimeTransport?.bufferedBytes || 0))
    : 0;
  if (runtimeTransport?.backpressure || runtimeBufferedBytes >= 128 * 1024) {
    return {
      headTickMs: 120,
      minTailRefreshGapMs: 120,
      headStalePingMs: 520,
      pullRequestStaleMs: 2500,
      readingSyncDelayMs: 72,
    };
  }

  const hasGoodRuntimeProgress = runtimeTransport
    && (runtimeTransport.hasRecentProgress || (runtimeRttMs > 0 && runtimeRttMs < 80));
  if (hasGoodRuntimeProgress) {
    return {
      headTickMs: 16,
      minTailRefreshGapMs: 16,
      headStalePingMs: 160,
      pullRequestStaleMs: 1200,
      readingSyncDelayMs: 16,
    };
  }

  if (network.rttMs >= 800) {
    return {
      headTickMs: 120,
      minTailRefreshGapMs: 120,
      headStalePingMs: 520,
      pullRequestStaleMs: 2500,
      readingSyncDelayMs: 72,
    };
  }

  if (network.rttMs >= 300) {
    return {
      headTickMs: 66,
      minTailRefreshGapMs: 66,
      headStalePingMs: 360,
      pullRequestStaleMs: 2000,
      readingSyncDelayMs: 48,
    };
  }

  if (network.saveData || network.effectiveType === 'slow-2g' || network.effectiveType === '2g') {
    return {
      headTickMs: 120,
      minTailRefreshGapMs: 120,
      headStalePingMs: 520,
      pullRequestStaleMs: 2200,
      readingSyncDelayMs: 72,
    };
  }

  if (network.effectiveType === '3g') {
    return {
      headTickMs: 66,
      minTailRefreshGapMs: 66,
      headStalePingMs: 320,
      pullRequestStaleMs: 1800,
      readingSyncDelayMs: 48,
    };
  }

  return {
    headTickMs: ACTIVE_HEAD_REFRESH_TICK_MS,
    minTailRefreshGapMs: ACTIVE_HEAD_REFRESH_TICK_MS,
    headStalePingMs: 200,
    pullRequestStaleMs: 1500,
    readingSyncDelayMs: 24,
  };
}

export function withDefaultBridgePort(port?: number | null) {
  return port || DEFAULT_BRIDGE_PORT;
}

export function resolveTerminalRequestWindowLines(rows?: number | null): number {
  const viewportRows =
    typeof rows === 'number' && Number.isFinite(rows)
      ? Math.max(1, Math.floor(rows))
      : 24;
  return sharedResolveRequestWindowLines(viewportRows);
}
