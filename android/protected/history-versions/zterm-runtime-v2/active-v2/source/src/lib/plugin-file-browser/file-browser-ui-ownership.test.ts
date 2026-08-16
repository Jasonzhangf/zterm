import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('file browser UI plugin ownership gate', () => {
  it('keeps TerminalPage on the typed file browser slot contract', () => {
    const terminalPage = readFileSync(
      join(root, 'src/pages/TerminalPage.tsx'),
      'utf8',
    );
    expect(terminalPage).not.toMatch(
      /from ['"]\.\.\/components\/terminal\/FileTransferSheet['"]/,
    );
    expect(terminalPage).toContain(
      "from '../lib/plugin-file-browser/file-browser-contract'",
    );
    expect(terminalPage).toContain('renderFileBrowser');
  });

  it('composes the file browser plugin only through App and the plugin host', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/file-browser-ui-plugin.tsx'),
      'utf8',
    );
    expect(app).toContain('FileBrowserUiPlugin');
    expect(app).toContain('FILE_BROWSER_UI_SLOT_ID');
    expect(plugin).toContain(
      "from '../../components/terminal/FileTransferSheet'",
    );
    expect(plugin).toContain('provideUiSlot');
  });
});
