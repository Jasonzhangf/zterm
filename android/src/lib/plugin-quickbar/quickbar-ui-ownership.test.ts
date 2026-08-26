import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('quickbar UI plugin ownership gate', () => {
  it('keeps TerminalPage on the typed quickbar slot contract', () => {
    const terminalPage = readFileSync(
      join(root, 'src/pages/TerminalPage.tsx'),
      'utf8',
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\.\/components\/terminal\/TerminalQuickBar['"]/,
    );
    expect(terminalPage).not.toMatch(/<TerminalQuickBar\b/);
    expect(terminalPage).toContain(
      "from '../lib/plugin-quickbar/quickbar-contract'",
    );
    expect(terminalPage).toContain('renderQuickBar');
  });

  it('composes the quickbar plugin only through App and the plugin host', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/quickbar-ui-plugin.tsx'),
      'utf8',
    );
    expect(app).toContain('QuickBarUiPlugin');
    expect(app).toContain('QUICKBAR_UI_SLOT_ID');
    expect(plugin).toContain(
      "from '../../components/terminal/TerminalQuickBar'",
    );
    expect(plugin).toContain('provideUiSlot');
  });

  it('keeps the plugin projection free of runtime and session owners', () => {
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/quickbar-ui-plugin.tsx'),
      'utf8',
    );
    expect(plugin).not.toMatch(/SessionContext|session-context|transport|WebSocket|terminal-message-runtime/);
    expect(plugin).not.toMatch(/from ['"][^'"]*\/server\//);
  });
});
