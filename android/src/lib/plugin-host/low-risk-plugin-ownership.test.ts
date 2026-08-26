import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

const lowRiskPlugins = [
  {
    id: 'DebugConsoleUiPlugin',
    slot: 'DEBUG_CONSOLE_UI_SLOT_ID',
    pluginPath: 'src/lib/plugin-host/debug-console-ui-plugin.tsx',
    contractPath: 'src/lib/plugin-debug-console/debug-console-contract.ts',
    forbiddenPageImports: ['TerminalDebugOverlay'],
  },
  {
    id: 'SessionDrawerUiPlugin',
    slot: 'SESSION_DRAWER_UI_SLOT_ID',
    pluginPath: 'src/lib/plugin-host/session-drawer-ui-plugin.tsx',
    contractPath: 'src/lib/plugin-session-drawer/session-drawer-contract.ts',
    forbiddenPageImports: ['TerminalSessionDrawer'],
  },
  {
    id: 'FileBrowserUiPlugin',
    slot: 'FILE_BROWSER_UI_SLOT_ID',
    pluginPath: 'src/lib/plugin-host/file-browser-ui-plugin.tsx',
    contractPath: 'src/lib/plugin-file-browser/file-browser-contract.ts',
    forbiddenPageImports: ['FileTransferSheet'],
  },
  {
    id: 'SettingsUpdateUiPlugin',
    slot: 'SETTINGS_UPDATE_UI_SLOT_ID',
    pluginPath: 'src/lib/plugin-host/settings-update-ui-plugin.tsx',
    contractPath: 'src/lib/plugin-settings-update/settings-update-contract.ts',
    forbiddenPageImports: ['AppUpdateSection'],
  },
] as const;

describe('low-risk UI plugin ownership gate', () => {
  it('composes every low-risk surface through the App plugin host', () => {
    const app = read('src/App.tsx');
    for (const plugin of lowRiskPlugins) {
      expect(app, plugin.id).toContain(plugin.id);
      expect(app, plugin.id).toContain(plugin.slot);
      expect(read(plugin.pluginPath), plugin.id).toContain('provideUiSlot');
    }
  });

  it('keeps pages and page helpers on plugin contracts, not component implementations', () => {
    const pageSources = [
      read('src/pages/TerminalPage.tsx'),
      read('src/pages/SettingsPage.tsx'),
      read('src/pages/terminal-page-helpers.ts'),
    ].join('\n');
    for (const plugin of lowRiskPlugins) {
      for (const implementationName of plugin.forbiddenPageImports) {
        expect(pageSources).not.toMatch(
          new RegExp(`from ['"][^'"]*${implementationName}['"]`),
        );
      }
      expect(read(plugin.contractPath), plugin.contractPath).not.toMatch(
        /from ['"]\.\.\/\.\.\/components\//,
      );
    }
  });

  it('keeps low-risk plugin hosts free of runtime truth owners', () => {
    for (const plugin of lowRiskPlugins) {
      const source = read(plugin.pluginPath);
      expect(source, plugin.id).not.toMatch(
        /from ['"](?:\.\.\/\.\.\/)?(?:contexts|server|hooks\/useSession|lib\/(?:session|terminal-buffer|traversal))/,
      );
    }
  });
});
