import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as os from 'node:os';
vi.mock('node:os', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:os')>(),
  homedir: vi.fn(),
}));
import {
  resolveTerminalBackendKind,
  resolveHerdrExecutable,
  resolveRexExecutable,
  isRexExecutableAvailable,
  resolveWezTermExecutable,
} from './terminal-backend-selection';
import {
  assertSupportedTerminalSourceKind,
  type TerminalSourceAdapter,
  type TerminalSourceMirrorSnapshot,
} from './terminal-source-adapter';

describe('Rex executable discovery', () => {
  const roots: string[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function fixture() {
    const home = mkdtempSync(join(tmpdir(), 'rex-executable-'));
    roots.push(home);
    vi.mocked(os.homedir).mockReturnValue(home);
    const installed = join(home, 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex');
    const pathRex = join(home, 'bin', 'rex');
    function executable(file: string, body = 'exit 0') {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, '#!/bin/sh\n' + body + '\n');
      chmodSync(file, 0o755);
    }
    return { home, installed, pathRex, executable };
  }
  it('discovers Current installed Rex under the restricted macOS service PATH', () => {
    const f = fixture(); f.executable(f.installed);
    expect(resolveRexExecutable({ PATH: '/usr/bin:/bin' }, 'darwin')).toBe(f.installed);
  });
  it('prefers an executable PATH entry over Current, skipping non-executable files and directories', () => {
    const f = fixture(); f.executable(f.installed); f.executable(f.pathRex);
    const env = { PATH: dirname(f.pathRex) };
    expect(resolveRexExecutable(env, 'darwin')).toBe(f.pathRex);
    chmodSync(f.pathRex, 0o644);
    expect(resolveRexExecutable(env, 'darwin')).toBe(f.installed);
    rmSync(f.pathRex); mkdirSync(f.pathRex);
    expect(resolveRexExecutable(env, 'darwin')).toBe(f.installed);
  });
  it('preserves explicit paths with spaces and their failure without alternate retry', () => {
    const f = fixture(); f.executable(f.installed);
    const explicit = join(f.home, 'explicit tool'); f.executable(explicit, 'exit 7');
    expect(resolveRexExecutable({ ZTERM_REX_EXE: ' ' + explicit + ' ', PATH: '' }, 'darwin')).toBe(explicit);
    expect(isRexExecutableAvailable(explicit)).toBe(false);
    chmodSync(explicit, 0o644);
    expect(resolveRexExecutable({ ZTERM_REX_EXE: explicit }, 'darwin')).toBe(explicit);
    expect(isRexExecutableAvailable(explicit)).toBe(false);
    rmSync(explicit);
    expect(resolveRexExecutable({ ZTERM_REX_EXE: explicit }, 'darwin')).toBe(explicit);
    expect(isRexExecutableAvailable(explicit)).toBe(false);
  });
  it('keeps unavailable bare Rex on non-macOS and when Current is not executable', () => {
    const f = fixture(); f.executable(f.installed);
    expect(resolveRexExecutable({ PATH: '' }, 'linux')).toBe('rex');
    expect(resolveRexExecutable({ PATH: '' }, 'win32')).toBe('rex');
    chmodSync(f.installed, 0o644);
    expect(resolveRexExecutable({ PATH: '', ZTERM_REX_EXE: '  ' }, 'darwin')).toBe('rex');
    rmSync(f.installed);
    expect(resolveRexExecutable({ PATH: '' }, 'darwin')).toBe('rex');
  });
});

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
