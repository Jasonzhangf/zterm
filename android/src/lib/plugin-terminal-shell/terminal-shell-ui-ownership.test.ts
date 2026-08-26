import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('terminal shell UI plugin ownership gate', () => {
  it('keeps TerminalPage on the typed terminal shell slot contract', () => {
    const terminalPage = readFileSync(
      join(root, 'src/pages/TerminalPage.tsx'),
      'utf8',
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\/TerminalConnectionStatusStrip['"]/,
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\/TerminalPageCopyMenu['"]/,
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\/TerminalPageStageShell['"]/,
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\/terminal-page-shell-ui['"]/,
    );
    expect(terminalPage).not.toMatch(/<TerminalStageShell\b/);
    expect(terminalPage).not.toMatch(/<TerminalConnectionStatusStrip\b/);
    expect(terminalPage).not.toMatch(/<TerminalPageCopyMenu\b/);
    expect(terminalPage).not.toMatch(/<TerminalQuickBarShell\b/);
    expect(terminalPage).not.toMatch(/<TerminalNetworkBanner\b/);
    expect(terminalPage).toContain(
      "from '../lib/plugin-terminal-shell/terminal-shell-contract'",
    );
    expect(terminalPage).toContain('renderTerminalShell');
  });

  it('composes the terminal shell plugin only through App and the plugin host', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/terminal-shell-ui-plugin.tsx'),
      'utf8',
    );
    expect(app).toContain('TerminalShellUiPlugin');
    expect(app).toContain('TERMINAL_SHELL_UI_SLOT_ID');
    expect(plugin).toContain(
      "from '../../pages/TerminalPageStageShell'",
    );
    expect(plugin).toContain('provideUiSlot');
  });

  it('keeps page shell tests on the plugin-provided renderer and no duplicate provider', () => {
    const pageTests = readdirSync(join(root, 'src/pages')).filter((file) => file.endsWith('.test.tsx'));
    for (const file of pageTests) {
      const source = readFileSync(join(root, 'src/pages', file), 'utf8');
      if (!source.includes('renderTerminalShellUi')) {
        continue;
      }
      expect(source, file).toMatch(/from\s+["']\.\.\/lib\/plugin-host\/terminal-shell-ui-plugin["']/);
      expect(source, file).not.toContain('terminal-shell-ui-test-provider');
    }
    expect(
      existsSync(join(root, 'src/lib/plugin-terminal-shell/terminal-shell-ui-test-provider.tsx')),
    ).toBe(false);
  });

  it('keeps the plugin projection free of runtime and session owners', () => {
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/terminal-shell-ui-plugin.tsx'),
      'utf8',
    );
    expect(plugin).not.toMatch(/SessionContext|session-context|transport|WebSocket|terminal-message-runtime/);
    expect(plugin).not.toMatch(/from ['"][^'"]*\/server\//);
  });
});
