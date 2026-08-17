import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('remote window UI plugin ownership gate', () => {
  it('keeps TerminalPage on the typed remote window slot contract', () => {
    const terminalPage = readFileSync(
      join(root, 'src/pages/TerminalPage.tsx'),
      'utf8',
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\.\/components\/terminal\/RemoteWindowOverlay['"]/,
    );
    expect(terminalPage).not.toMatch(/<RemoteWindowOverlay/);
    expect(terminalPage).toContain(
      "from '../lib/plugin-remote-window/remote-window-contract'",
    );
    expect(terminalPage).toContain('renderRemoteWindow');
  });

  it('composes the remote window plugin only through App and the plugin host', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/remote-window-ui-plugin.tsx'),
      'utf8',
    );
    expect(app).toContain('RemoteWindowUiPlugin');
    expect(app).toContain('REMOTE_WINDOW_UI_SLOT_ID');
    expect(plugin).toContain(
      "from '../../components/terminal/RemoteWindowOverlay'",
    );
    expect(plugin).toContain('provideUiSlot');
  });
});
