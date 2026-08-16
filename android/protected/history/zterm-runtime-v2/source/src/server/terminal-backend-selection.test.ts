import { describe, expect, it } from 'vitest';
import {
  resolveTerminalBackendKind,
  resolveHerdrExecutable,
  resolveWezTermExecutable,
} from './terminal-backend-selection';
import {
  assertSupportedTerminalSourceKind,
  type TerminalSourceAdapter,
  type TerminalSourceMirrorSnapshot,
} from './terminal-source-adapter';

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
    expect(resolveTerminalBackendKind({ platform: 'darwin', env: { ZTERM_TERMINAL_BACKEND: 'herdr' } })).toBe('herdr');
    expect(() => resolveTerminalBackendKind({ env: { ZTERM_TERMINAL_BACKEND: 'screen' } })).toThrow(
      'unsupported terminal source kind: screen',
    );
  });

  it('uses an explicit wezterm executable path when configured', () => {
    expect(resolveWezTermExecutable({})).toBe('wezterm.exe');
    expect(resolveWezTermExecutable({ ZTERM_WEZTERM_EXE: 'D:/tools/wezterm.exe' })).toBe('D:/tools/wezterm.exe');
  });

  it('uses the official Herdr executable without selecting it implicitly', () => {
    expect(resolveHerdrExecutable({})).toBe('herdr');
    expect(resolveHerdrExecutable({ ZTERM_HERDR_EXE: '/opt/herdr/bin/herdr' })).toBe('/opt/herdr/bin/herdr');
    expect(resolveTerminalBackendKind({ platform: 'darwin', env: {} })).toBe('tmux');
  });

  it('validates the unified terminal source kind without a tmux fallback', () => {
    expect(assertSupportedTerminalSourceKind('tmux')).toBe('tmux');
    expect(assertSupportedTerminalSourceKind('herdr')).toBe('herdr');
    expect(assertSupportedTerminalSourceKind('wezterm')).toBe('wezterm');
    expect(() => assertSupportedTerminalSourceKind('screen')).toThrow(
      'unsupported terminal source kind: screen',
    );
    expect(() => assertSupportedTerminalSourceKind(undefined)).toThrow(
      'unsupported terminal source kind: <empty>',
    );
  });

  it('exposes one source-neutral mirror snapshot contract to mirror consumers', async () => {
    const snapshot: TerminalSourceMirrorSnapshot = {
      revision: 1,
      bufferStartIndex: 100,
      bufferLines: [[{ char: 65, fg: 1, bg: 256, flags: 0, width: 1 }]],
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: { rowIndex: 100, col: 0, visible: true },
      lastScrollbackCount: 0,
      totalAvailableLines: 101,
    };
    const adapter: TerminalSourceAdapter = {
      kind: 'tmux',
      listSessions: () => [],
      createSession: () => {
        throw new Error('test adapter does not create sessions');
      },
      readSnapshot: async () => snapshot,
      writeInput: () => {
        throw new Error('test adapter does not write input');
      },
      closeSession: () => {
        throw new Error('test adapter does not close sessions');
      },
      readCurrentPath: () => '/workspace',
    };

    await expect(adapter.readSnapshot('demo')).resolves.toEqual(snapshot);
    expect(adapter.kind).toBe('tmux');
  });
});
