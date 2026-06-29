import { describe, expect, it } from 'vitest';
import {
  resolveTerminalBackendKind,
  resolveWezTermExecutable,
} from './terminal-backend-selection';

describe('terminal backend selection', () => {
  it('keeps tmux as the default backend outside Windows', () => {
    expect(resolveTerminalBackendKind({ platform: 'darwin', env: {} })).toBe('tmux');
    expect(resolveTerminalBackendKind({ platform: 'linux', env: {} })).toBe('tmux');
  });

  it('selects wezterm on Windows without falling back through tmux', () => {
    expect(resolveTerminalBackendKind({ platform: 'win32', env: {} })).toBe('wezterm');
  });

  it('honors explicit backend selection and rejects unknown values', () => {
    expect(resolveTerminalBackendKind({ platform: 'darwin', env: { ZTERM_TERMINAL_BACKEND: 'wezterm' } })).toBe('wezterm');
    expect(resolveTerminalBackendKind({ platform: 'win32', env: { ZTERM_TERMINAL_BACKEND: 'tmux' } })).toBe('tmux');
    expect(() => resolveTerminalBackendKind({ env: { ZTERM_TERMINAL_BACKEND: 'screen' } })).toThrow(
      'unsupported ZTERM_TERMINAL_BACKEND: screen',
    );
  });

  it('uses an explicit wezterm executable path when configured', () => {
    expect(resolveWezTermExecutable({})).toBe('wezterm.exe');
    expect(resolveWezTermExecutable({ ZTERM_WEZTERM_EXE: 'D:/tools/wezterm.exe' })).toBe('D:/tools/wezterm.exe');
  });
});
