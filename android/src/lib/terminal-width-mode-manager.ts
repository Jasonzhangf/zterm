import type { BridgeSettings } from './bridge-settings';
import type { TerminalWidthMode } from './types';

export interface TerminalWidthModeOption {
  id: TerminalWidthMode;
  label: string;
}

export const TERMINAL_WIDTH_MODE_OPTIONS: readonly TerminalWidthModeOption[] = [
  { id: 'adaptive-phone', label: '适应手机屏宽' },
  { id: 'mirror-fixed', label: '保持远端宽度' },
] as const;

export function normalizeTerminalWidthMode(mode: unknown): TerminalWidthMode {
  return mode === 'mirror-fixed' ? 'mirror-fixed' : 'adaptive-phone';
}

export function updateBridgeSettingsTerminalWidthMode(
  settings: BridgeSettings,
  mode: unknown,
): BridgeSettings {
  const normalizedMode = normalizeTerminalWidthMode(mode);
  if (settings.terminalWidthMode === normalizedMode) {
    return settings;
  }
  return {
    ...settings,
    terminalWidthMode: normalizedMode,
  };
}
