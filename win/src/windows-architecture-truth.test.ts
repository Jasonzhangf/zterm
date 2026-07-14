import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('windows desktop shell architecture truth', () => {
  it('binds real Electron/preload/renderer entries and the shared renderer', () => {
    expect(read('electron/main.ts')).toContain('new BrowserWindow');
    expect(read('electron/main.ts')).toContain("preload.cjs");
    expect(read('electron/preload.cts')).toContain("exposeInMainWorld('ztermWindows'");
    expect(read('src/main.tsx')).toContain('<WindowsDesktopApp />');
    expect(read('src/WindowsDesktopApp.tsx')).toContain('MacTerminalView');
    expect(read('src/windows-terminal-session.ts')).toContain('applyBufferSyncToSessionBuffer');
  });

  it('does not import Mac IPC, local tmux, daemon, mirror, or renderer copies', () => {
    const source = [read('electron/main.ts'), read('electron/preload.cts'), read('src/WindowsDesktopApp.tsx'), read('src/windows-terminal-session.ts')].join('\n');
    expect(source).not.toContain('ztermMac');
    expect(source).not.toContain('local-tmux');
    expect(source).not.toContain('src/server');
    expect(source).not.toContain('terminal-mirror');
    expect(source).not.toContain('wezterm-backend');
  });

  it('locks packaged preload to a CommonJS artifact for Electron sandbox loading', () => {
    expect(read('electron/preload.cts')).toContain("from 'electron'");
    expect(read('electron/main.ts')).toContain("path.join(__dirname, 'preload.cjs')");
  });
});
