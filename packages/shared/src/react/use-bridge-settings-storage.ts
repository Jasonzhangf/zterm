import { useEffect, useState } from 'react';
import { DEFAULT_BRIDGE_SETTINGS, normalizeBridgeSettings, type BridgeSettings } from '../connection/bridge-settings';
import { STORAGE_KEYS } from '../connection/types';

function resolveInitialTerminalWidthMode() {
  if (typeof window === 'undefined') {
    return DEFAULT_BRIDGE_SETTINGS.terminalWidthMode;
  }
  const visualViewportWidth = Math.round(window.visualViewport?.width || 0);
  const innerWidth = Math.round(window.innerWidth || 0);
  const documentClientWidth = Math.round(window.document?.documentElement?.clientWidth || 0);
  const width = visualViewportWidth || innerWidth || documentClientWidth;
  return width > 0 && width <= 700 ? 'adaptive-phone' : 'mirror-fixed';
}

function buildDetectedDefaultBridgeSettings(): BridgeSettings {
  return {
    ...DEFAULT_BRIDGE_SETTINGS,
    terminalWidthMode: resolveInitialTerminalWidthMode(),
  };
}

function readStoredBridgeSettings(): BridgeSettings {
  if (typeof window === 'undefined') {
    return buildDetectedDefaultBridgeSettings();
  }

  try {
    const stored = localStorage.getItem(STORAGE_KEYS.BRIDGE_SETTINGS);
    if (!stored) {
      return buildDetectedDefaultBridgeSettings();
    }

    return normalizeBridgeSettings(JSON.parse(stored));
  } catch (error) {
    console.error('[useBridgeSettingsStorage] Failed to load bridge settings:', error);
    return buildDetectedDefaultBridgeSettings();
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
