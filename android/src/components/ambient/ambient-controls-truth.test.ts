import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

function read(relativePath: string) {
  return readFileSync(join(root, relativePath), 'utf8');
}

describe('ambient control ownership truth', () => {
  it('keeps the shared control owner present and exported', () => {
    expect(existsSync(join(root, 'src/components/ambient/AmbientButton.tsx'))).toBe(true);
    expect(existsSync(join(root, 'src/components/ambient/AmbientInput.tsx'))).toBe(true);
    expect(existsSync(join(root, 'src/components/ambient/AmbientSelect.tsx'))).toBe(true);
    expect(existsSync(join(root, 'src/components/ambient/AmbientTextarea.tsx'))).toBe(true);
    const barrel = read('src/components/ambient/index.ts');
    expect(barrel).toContain('AmbientButton');
    expect(barrel).toContain("export type { AmbientButtonProps, AmbientButtonVariant }");
    expect(barrel).toContain('AmbientInput');
    expect(barrel).toContain('AmbientSelect');
    expect(barrel).toContain('AmbientTextarea');
  });

  it('keeps migrated page buttons consuming AmbientButton instead of local variant styles', () => {
    const connectionsPage = read('src/pages/ConnectionsPage.tsx');
    const connectionPropertiesPage = read('src/pages/ConnectionPropertiesPage.tsx');
    expect(connectionsPage).toContain("import { AmbientButton } from '../components/ambient';");
    expect(connectionsPage).not.toMatch(/<button\b/);
    expect(connectionsPage).toContain('variant="settings"');
    expect(connectionsPage).toContain('variant="accent"');
    expect(connectionsPage).toContain('variant="accent-wide"');
    expect(connectionsPage).toContain('variant="active-session"');
    expect(connectionsPage).toContain('variant="saved-open"');
    expect(connectionPropertiesPage).toContain("from '../components/ambient'");
    expect(connectionPropertiesPage).toContain('AmbientButton');
    expect(connectionPropertiesPage).toContain('AmbientTextarea');
    expect(connectionPropertiesPage).not.toMatch(/<button\b/);
    expect(connectionPropertiesPage).toContain('variant="back"');
    expect(connectionPropertiesPage).toContain('variant="save"');
    expect(connectionPropertiesPage).toContain('variant="compact-accent"');
    expect(connectionPropertiesPage).toContain('variant="option"');
    expect(connectionPropertiesPage).toContain('variant="option-strong"');
    expect(connectionPropertiesPage).toContain('variant="discover"');
    expect(connectionPropertiesPage).toContain('variant="outline"');
  });

  it('keeps SettingsPage consuming shared controls instead of local control styles', () => {
    const settingsPage = read('src/pages/SettingsPage.tsx');
    expect(settingsPage).toContain(
      "import {\n  AmbientButton,\n  AmbientInput,\n  AmbientSelect,\n  AmbientTextarea,\n} from '../components/ambient';",
    );
    expect(settingsPage).not.toMatch(/<(?:button|input|select|textarea)\b/);
    expect(settingsPage).toContain('variant="settings-back"');
    expect(settingsPage).toContain('variant="settings-save"');
    expect(settingsPage).toContain('variant="settings-segment"');
    expect(settingsPage).toContain('variant="settings-toggle"');
    expect(settingsPage).toContain('variant="settings-skin-option"');
    expect(settingsPage).toContain('<AmbientInput');
    expect(settingsPage).toContain('<AmbientSelect');
    expect(settingsPage).toContain('<AmbientTextarea');
  });

  it('keeps TerminalHeader consuming shared controls for its local buttons', () => {
    const header = read('src/components/terminal/TerminalHeader.tsx');
    expect(header).toContain("import { AmbientButton } from '../ambient';");
    expect(header).not.toMatch(/<button\b/);
    expect(header).toContain('variant="terminal-pane-menu"');
    expect(header).toContain('variant="terminal-route-badge"');
  });

  it('keeps remaining live terminal surfaces consuming shared controls', () => {
    const files = [
      'src/components/terminal/TerminalQuickBar.tsx',
      'src/components/tmux/TmuxSessionPickerSheet.tsx',
      'src/components/terminal/SessionScheduleSheet.tsx',
      'src/components/terminal/FileTransferSheet.tsx',
      'src/components/terminal/TerminalSessionDrawerContent.tsx',
      'src/components/terminal/AttachmentDrawer.tsx',
      'src/components/terminal/TerminalPreviewGrid.tsx',
      'src/components/terminal/ResourceBottomSheet.tsx',
      'src/components/terminal/RemoteScreenshotSheet.tsx',
      'src/components/terminal/RemoteWindowMorePanel.tsx',
      'src/components/terminal/RemoteWindowOverlayController.tsx',
      'src/components/terminal/RemoteWindowTargetPicker.tsx',
      'src/components/terminal/RemoteWindowLockedToolbar.tsx',
      'src/components/terminal/RemoteWindowAppSwitch.tsx',
      'src/components/terminal/TabManagerSheet.tsx',
    ];
    for (const file of files) {
      const source = read(file);
      expect(source).not.toMatch(/<(?:\/?)(?:button|input|select|textarea)\b/);
    }
  });

  it('keeps the shared owner free of business and terminal truth imports', () => {
    const owner = read('src/components/ambient/AmbientButton.tsx');
    expect(owner).not.toMatch(/from ['"](?:\.\.\/)+(?:contexts|server|components\/TerminalView)/);
    expect(owner).not.toMatch(/from ['"].*(?:session|transport|mirror|renderer|buffer)/i);
    expect(owner).toContain('mobileTheme');
  });

  it('keeps ambient production CSS and shared control class wiring in place', () => {
    const indexCss = read('src/index.css');
    expect(indexCss).toContain('@import "./ambient.css";');
    expect(indexCss).toContain('data-terminal-shell-skin="black"');
    expect(indexCss).toContain('data-terminal-shell-skin="light"');
    expect(indexCss).toContain('--amb-key-light-intensity');
    expect(indexCss).toContain('--amb-albedo');
    expect(indexCss).toContain('--amb-elevation');

    const ambientCss = read('src/ambient.css');
    expect(ambientCss).toContain('--amb-key-light-intensity');
    expect(ambientCss).toContain('.amb-button');
    expect(ambientCss).toContain('.amb-chamfer');

    for (const file of [
      'src/components/ambient/AmbientButton.tsx',
      'src/components/ambient/AmbientInput.tsx',
      'src/components/ambient/AmbientSelect.tsx',
      'src/components/ambient/AmbientTextarea.tsx',
    ]) {
      const owner = read(file);
      expect(owner).toContain("'ambient-control'");
      expect(owner).toContain("'amb-chamfer'");
    }
  });
});
