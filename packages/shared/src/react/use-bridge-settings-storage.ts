import { useEffect, useState } from 'react';
import { DEFAULT_BRIDGE_SETTINGS, normalizeBridgeSettings, type BridgeSettings } from '../connection/bridge-settings';
import { STORAGE_KEYS } from '../connection/types';

function readStoredBridgeSettings(): BridgeSettings {
  if (typeof window === 'undefined') {
    return DEFAULT_BRIDGE_SETTINGS;
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS);
    if (!stored) {
      return DEFAULT_BRIDGE_SETTINGS;
    }

    return normalizeBridgeSettings(JSON.parse(stored));
  } catch (error) {
    console.error('[useBridgeSettingsStorage] Failed to load bridge settings:', error);
    return DEFAULT_BRIDGE_SETTINGS;
  }
}

export function useBridgeSettingsStorage() {
  const [settings, setSettingsState] = useState<BridgeSettings>(() => readStoredBridgeSettings());

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    setSettingsState(readStoredBridgeSettings());
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
