import { describe, expect, it } from 'vitest';
import type { BridgeSettings } from './bridge-settings';
import {
  TERMINAL_WIDTH_MODE_OPTIONS,
  buildTerminalWidthModePayload,
  normalizeTerminalWidthMode,
  updateBridgeSettingsTerminalWidthMode,
} from './terminal-width-mode-manager';

const baseSettings: BridgeSettings = {
  targetHost: '',
  targetPort: 3333,
  targetAuthToken: '',
  signalUrl: '',
  turnServerUrl: '',
  turnUsername: '',
  turnCredential: '',
  transportMode: 'auto',
  terminalCacheLines: 1000,
  terminalThemeId: 'classic-dark',
  terminalWidthMode: 'mirror-fixed',
  shortcutSmartSort: true,
  servers: [],
  defaultServerId: undefined,
};

describe('terminal-width-mode-manager', () => {
  it('exports the shared width-mode options once', () => {
    expect(TERMINAL_WIDTH_MODE_OPTIONS).toEqual([
      { id: 'mirror-fixed', label: 'Mirror Fixed' },
      { id: 'adaptive-phone', label: 'Adaptive Phone' },
    ]);
  });

  it('normalizes any unknown mode back to mirror-fixed', () => {
    expect(normalizeTerminalWidthMode('adaptive-phone')).toBe('adaptive-phone');
    expect(normalizeTerminalWidthMode('mirror-fixed')).toBe('mirror-fixed');
    expect(normalizeTerminalWidthMode('weird-mode')).toBe('mirror-fixed');
    expect(normalizeTerminalWidthMode(null)).toBe('mirror-fixed');
  });

  it('updates bridge settings through one helper', () => {
    const next = updateBridgeSettingsTerminalWidthMode(baseSettings, 'adaptive-phone');
    expect(next).toEqual({
      ...baseSettings,
      terminalWidthMode: 'adaptive-phone',
    });
    expect(updateBridgeSettingsTerminalWidthMode(next, 'adaptive-phone')).toBe(next);
  });

  it('builds daemon width-mode payloads with normalized cols only for adaptive-phone', () => {
    expect(buildTerminalWidthModePayload('mirror-fixed', 120)).toEqual({
      mode: 'mirror-fixed',
    });

    expect(buildTerminalWidthModePayload('adaptive-phone', 91.8)).toEqual({
      mode: 'adaptive-phone',
      cols: 91,
    });

    expect(buildTerminalWidthModePayload('adaptive-phone', null)).toEqual({
      mode: 'adaptive-phone',
    });
  });
});
