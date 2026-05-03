import type { BridgeSettings } from './bridge-settings';
import type { TerminalWidthMode } from './types';

export interface TerminalWidthModeOption {
  id: TerminalWidthMode;
  label: string;
}

export const TERMINAL_WIDTH_MODE_OPTIONS: readonly TerminalWidthModeOption[] = [
  { id: 'mirror-fixed', label: 'Mirror Fixed' },
  { id: 'adaptive-phone', label: 'Adaptive Phone' },
] as const;

export function normalizeTerminalWidthMode(mode: unknown): TerminalWidthMode {
  return mode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed';
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

export function buildTerminalWidthModePayload(mode: unknown, cols?: number | null) {
  const normalizedMode = normalizeTerminalWidthMode(mode);
  if (normalizedMode !== 'adaptive-phone') {
    return { mode: normalizedMode } as const;
  }

  const normalizedCols =
    typeof cols === 'number' && Number.isFinite(cols) && cols > 0
      ? Math.max(1, Math.floor(cols))
      : null;

  return normalizedCols === null
    ? ({ mode: normalizedMode } as const)
    : ({ mode: normalizedMode, cols: normalizedCols } as const);
}
