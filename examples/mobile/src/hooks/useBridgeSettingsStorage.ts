import { useEffect, useState } from 'react';
import { DEFAULT_BRIDGE_SETTINGS, buildServerPresetId, sortBridgeServers, type BridgeSettings, type BridgeServerPreset } from '../lib/bridge-settings';
import { DEFAULT_TERMINAL_CACHE_LINES } from '../lib/mobile-config';
import { STORAGE_KEYS } from '../lib/types';

function normalizeBridgeSettings(input: unknown): BridgeSettings {
  if (!input || typeof input !== 'object') {
    return DEFAULT_BRIDGE_SETTINGS;
  }

  const candidate = input as Partial<BridgeSettings>;
  const servers: BridgeServerPreset[] = [];

  if (Array.isArray(candidate.servers)) {
    for (const item of candidate.servers) {
      if (!item || typeof item !== 'object') {
        continue;
      }
      const server = item as Partial<BridgeServerPreset>;
      const targetHost = typeof server.targetHost === 'string' ? server.targetHost.trim() : '';
      const targetPort =
        typeof server.targetPort === 'number' && Number.isFinite(server.targetPort)
          ? server.targetPort
          : DEFAULT_BRIDGE_SETTINGS.targetPort;
      if (!targetHost) {
        continue;
      }
      servers.push({
        id:
          typeof server.id === 'string' && server.id.trim()
            ? server.id
            : buildServerPresetId(targetHost, targetPort),
        name: typeof server.name === 'string' && server.name.trim() ? server.name : targetHost,
        targetHost,
        targetPort,
        authToken: typeof server.authToken === 'string' ? server.authToken : undefined,
      });
    }
  }

  const targetHost = typeof candidate.targetHost === 'string' ? candidate.targetHost.trim() : DEFAULT_BRIDGE_SETTINGS.targetHost;
  const targetPort =
    typeof candidate.targetPort === 'number' && Number.isFinite(candidate.targetPort)
      ? candidate.targetPort
      : DEFAULT_BRIDGE_SETTINGS.targetPort;
  const targetAuthToken = typeof candidate.targetAuthToken === 'string' ? candidate.targetAuthToken : DEFAULT_BRIDGE_SETTINGS.targetAuthToken;
  const terminalCacheLines =
    typeof candidate.terminalCacheLines === 'number' && Number.isFinite(candidate.terminalCacheLines)
      ? Math.max(200, Math.floor(candidate.terminalCacheLines))
      : DEFAULT_TERMINAL_CACHE_LINES;
  const mergedServers =
    targetHost && servers.every((server) => server.targetHost !== targetHost || server.targetPort !== targetPort)
      ? sortBridgeServers([
          ...servers,
          {
            id: buildServerPresetId(targetHost, targetPort),
            name: targetHost,
            targetHost,
            targetPort,
            authToken: targetAuthToken || '',
          },
        ])
      : sortBridgeServers(servers);

  return {
    targetHost,
    targetPort,
    targetAuthToken,
    terminalCacheLines,
    servers: mergedServers,
    defaultServerId:
      typeof candidate.defaultServerId === 'string'
        ? candidate.defaultServerId
        : mergedServers.find((server) => server.targetHost === targetHost && server.targetPort === targetPort)?.id,
  };
}

export function useBridgeSettingsStorage() {
  const [settings, setSettingsState] = useState<BridgeSettings>(DEFAULT_BRIDGE_SETTINGS);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    try {
      const stored = localStorage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS);
      if (!stored) {
        return;
      }

      setSettingsState(normalizeBridgeSettings(JSON.parse(stored)));
    } catch (error) {
      console.error('[useBridgeSettingsStorage] Failed to load bridge settings:', error);
    }
  }, []);

  const setSettings = (next: BridgeSettings | ((current: BridgeSettings) => BridgeSettings)) => {
    setSettingsState((current) => {
      const value = typeof next === 'function' ? next(current) : next;
      if (typeof window !== 'undefined') {
        localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify(value));
      }
      return value;
    });
  };

  return {
    settings,
    setSettings,
  };
}
