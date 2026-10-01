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
    expect(read('src/windows-workspace.ts')).toContain('addPaneToWorkspace');
    expect(read('src/windows-terminal-registry.ts')).toContain('createWindowsTerminalRegistry');
    expect(read('electron/windows-file-system.ts')).toContain('registerWindowsFileSystemIpcHandlers');
    expect(read('src/WindowsFileBrowserPanel.tsx')).toContain('decideFileBrowserPreview');
  });

  it('does not import Mac IPC, local tmux, daemon, mirror, or renderer copies', () => {
    const source = [read('electron/main.ts'), read('electron/preload.cts'), read('electron/windows-file-system.ts'), read('src/WindowsDesktopApp.tsx'), read('src/WindowsFileBrowserPanel.tsx'), read('src/windows-terminal-session.ts'), read('src/windows-workspace.ts'), read('src/windows-terminal-registry.ts')].join('\n');
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

  it('builds workspace gateway packages before the packaged main process', () => {
    const packageJson = JSON.parse(read('package.json'));
    expect(packageJson.scripts['build:main']).toContain('packages/runtime-contracts run build');
    expect(packageJson.scripts['build:main']).toContain('packages/desktop-gateway run build');
    expect(packageJson.scripts['build:main']).toContain('tsc -p tsconfig.node.json');
    expect(packageJson.scripts['build:main']).toContain(
      'esbuild electron/preload.cts --bundle --platform=node --format=cjs --target=node20 --external:electron --outfile=dist-electron/electron/preload.cjs',
    );
  });

  it('declares every packaged main-process runtime import as a production dependency', () => {
    const packageJson = JSON.parse(read('package.json'));
    const runtimeSources = [read('electron/main.ts'), read('electron/windows-file-system.ts')].join('\n');
    const specifiers = [...runtimeSources.matchAll(/(?:from|import)\s+'([^']+)'/g)].map((match) => match[1]!);
    const nodeBuiltins = new Set(['url', 'path', 'fs', 'fs/promises', 'crypto', 'os']);
    const runtimePackages = specifiers
      .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:') && !nodeBuiltins.has(specifier))
      // Electron is provided by the packaged runtime binary, not by node_modules.
      .filter((specifier) => specifier !== 'electron')
      .map((specifier) => (specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!));

    expect(runtimePackages).toContain('@zterm/desktop-gateway');
    for (const name of runtimePackages) {
      expect(Object.keys(packageJson.dependencies)).toContain(name);
      expect(Object.keys(packageJson.devDependencies)).not.toContain(name);
    }
  });

  it('locks Windows installer, icon, and generic update channel metadata', () => {
    const packageJson = JSON.parse(read('package.json'));
    expect(packageJson.build.win.icon).toBe('build/icon.ico');
    expect(JSON.stringify(packageJson.build.win.target)).toContain('nsis');
    expect(JSON.stringify(packageJson.build.win.target)).toContain('dir');
    expect(packageJson.build.nsis.oneClick).toBe(false);
    expect(packageJson.build.nsis.allowToChangeInstallationDirectory).toBe(true);
    expect(packageJson.build.publish[0].provider).toBe('generic');
    const verifyScript = read('scripts/verify-windows-package.mjs');
    expect(verifyScript).toContain('alpha.yml');
    // The asar header pickle length is authoritative; a padding-byte heuristic
    // misreads 3-byte padding and shifts every packed file by one byte.
    expect(verifyScript).toContain('8 + headerPickleSize');
    expect(verifyScript).not.toContain('paddingBytes');
  });

  it('binds the DAGPipe windows remote-access graph to win owners and the phase0 gate', () => {
    const graph = JSON.parse(readFileSync(
      path.join(root, '..', 'android', 'docs', 'dagpipe', 'windows-remote-access-client.graph.json'),
      'utf8',
    ));
    expect(graph.id).toBe('windows.remote_access_client');
    expect(graph.inputs.map((input: { id: string }) => input.id)).toEqual(['arc.request']);
    expect(graph.outputs).toEqual(['arc.windows_remote_access_result']);

    const operators = new Set(graph.nodes.map((node: { operator: string }) => node.operator));
    const ownerBindings: Array<[string, string, string]> = [
      ['windows.profile_store.select', 'src/windows-profile-store.ts', 'createWindowsProfileStore'],
      ['windows.profile_store.resolve_target', 'src/windows-profile-store.ts', 'resolveTarget'],
      ['windows.session_catalog.list', 'src/windows-terminal-session.ts', 'createWindowsSessionControl'],
      ['windows.sidebar.project', 'src/WindowsDesktopApp.tsx', 'WindowsSidebar'],
      ['windows.session_transport.bind_shared', 'src/windows-terminal-session.ts', 'openBridgeConnection'],
      ['windows.workspace.compose', 'src/windows-workspace.ts', 'splitWindowsWorkspace'],
      ['windows.shell.render_shared_terminal', 'src/WindowsDesktopApp.tsx', 'MacTerminalView'],
      ['windows.statusbar.project', 'src/WindowsStatusBar.tsx', 'WindowsSessionStatus'],
      ['windows.file_browser.project', 'src/WindowsFileBrowserPanel.tsx', 'WindowsFileBrowserPanel'],
      ['windows.workspace.cleanup_runtime', 'src/windows-workspace.ts', 'closeWindowsWorkspaceTarget'],
    ];
    for (const [operator, file, marker] of ownerBindings) {
      expect(operators.has(operator), operator).toBe(true);
      expect(read(file), `${operator} -> ${marker}`).toContain(marker);
    }

    const androidPackage = JSON.parse(readFileSync(path.join(root, '..', 'android', 'package.json'), 'utf8'));
    expect(androidPackage.scripts['test:dagpipe-phase0']).toContain('validate-dagpipe-graphs.mjs');
    const validator = readFileSync(path.join(root, '..', 'android', 'scripts', 'validate-dagpipe-graphs.mjs'), 'utf8');
    expect(validator).toContain('.graph.json');
  });
});
