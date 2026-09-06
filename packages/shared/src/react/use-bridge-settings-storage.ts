import { useCallback, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_BRIDGE_SETTINGS,
  normalizeBridgeSettings,
  type BridgeSettings,
  type TerminalWidthMode,
} from '../connection/bridge-settings';
import { STORAGE_KEYS } from '../connection/types';

function normalizeStoredTerminalWidthMode(input: unknown): TerminalWidthMode | null {
  return input === 'adaptive-phone' || input === 'mirror-fixed' ? input : null;
}

function readStoredTerminalWidthModePreference(): TerminalWidthMode | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return normalizeStoredTerminalWidthMode(localStorage.getItem(STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE));
  } catch (error) {
    console.error('[useBridgeSettingsStorage] Failed to load terminal width mode preference:', error);
    return null;
  }
}

function writeStoredTerminalWidthModePreference(mode: TerminalWidthMode) {
  if (typeof window === 'undefined') {
    return;
  }
  localStorage.setItem(STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE, mode);
}

export type BridgeSettingsWriteResult =
  | {
      ok: true;
      settings: BridgeSettings;
      persistedKeys: string[];
    }
  | {
      ok: false;
      error: unknown;
      persistedKeys: string[];
    };

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

function normalizeStoredBridgeSettings(input: unknown): BridgeSettings {
  if (!input || typeof input !== 'object') {
    return buildDetectedDefaultBridgeSettings();
  }
  const candidate = input as Partial<BridgeSettings>;
  const storedPreference = readStoredTerminalWidthModePreference();
  return normalizeBridgeSettings({
    ...candidate,
    terminalWidthMode:
      candidate.terminalWidthMode === 'adaptive-phone' ||
      candidate.terminalWidthMode === 'mirror-fixed'
        ? candidate.terminalWidthMode
        : storedPreference
          ? storedPreference
        : resolveInitialTerminalWidthMode(),
  });
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

    return normalizeStoredBridgeSettings(JSON.parse(stored));
  } catch (error) {
    console.error('[useBridgeSettingsStorage] Failed to load bridge settings:', error);
    return buildDetectedDefaultBridgeSettings();
  }
}

export function useBridgeSettingsStorage() {
  const [settings, setSettingsState] = useState<BridgeSettings>(() => readStoredBridgeSettings());
  const committedSettingsRef = useRef(settings);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const next = readStoredBridgeSettings();
    committedSettingsRef.current = next;
    setSettingsState(next);
  }, []);

  const setSettings = useCallback((next: BridgeSettings | ((current: BridgeSettings) => BridgeSettings)): BridgeSettingsWriteResult => {
    const value = typeof next === 'function' ? next(committedSettingsRef.current) : next;
    const persistedKeys: string[] = [];
    if (typeof window !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEYS.BRIDGE_SETTINGS, JSON.stringify(value));
        persistedKeys.push(STORAGE_KEYS.BRIDGE_SETTINGS);
      } catch (error) {
        return { ok: false, error, persistedKeys };
      }
      try {
        writeStoredTerminalWidthModePreference(value.terminalWidthMode);
        persistedKeys.push(STORAGE_KEYS.TERMINAL_WIDTH_MODE_PREFERENCE);
      } catch (error) {
        committedSettingsRef.current = value;
        return { ok: false, error, persistedKeys };
      }
    }
    committedSettingsRef.current = value;
    setSettingsState(value);
    return { ok: true, settings: value, persistedKeys };
  }, []);

  return {
    settings,
    setSettings,
  };
}
