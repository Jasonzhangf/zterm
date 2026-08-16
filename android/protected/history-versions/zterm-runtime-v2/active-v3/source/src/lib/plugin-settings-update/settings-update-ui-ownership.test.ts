import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

describe('settings update UI plugin ownership gate', () => {
  it('keeps SettingsPage on the typed settings update slot contract', () => {
    const settingsPage = readFileSync(
      join(root, 'src/pages/SettingsPage.tsx'),
      'utf8',
    );
    expect(settingsPage).not.toMatch(
      /from ['"]\.\.\/components\/settings\/AppUpdateSection['"]/,
    );
    expect(settingsPage).toContain(
      "from '../lib/plugin-settings-update/settings-update-contract'",
    );
    expect(settingsPage).toContain('renderSettingsUpdate');
  });

  it('composes the settings update plugin only through App and the plugin host', () => {
    const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
    const plugin = readFileSync(
      join(root, 'src/lib/plugin-host/settings-update-ui-plugin.tsx'),
      'utf8',
    );
    expect(app).toContain('SettingsUpdateUiPlugin');
    expect(app).toContain('SETTINGS_UPDATE_UI_SLOT_ID');
    expect(plugin).toContain(
      "from '../../components/settings/AppUpdateSection'",
    );
    expect(plugin).toContain('provideUiSlot');
  });
});
