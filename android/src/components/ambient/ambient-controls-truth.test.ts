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
    expect(owner).toContain('var(--amb-control-bg)');
  });

  it('keeps ambient production CSS and shared control class wiring in place', () => {
    const indexCss = read('src/index.css');
    expect(indexCss).toContain('@import "./ambient.css";');

    const ambientCss = read('src/ambient.css');
    expect(ambientCss).toContain('data-terminal-shell-skin="black"');
    expect(ambientCss).toContain('data-terminal-shell-skin="light"');
    expect(ambientCss).toContain('--amb-key-light-intensity');
    expect(ambientCss).toContain('--amb-albedo');
    expect(ambientCss).toContain('--amb-elevation');
    expect(ambientCss).toContain('.amb-button');
    expect(ambientCss).toContain(':not([data-amb-flat="true"])');
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

  it('routes shared control surfaces through the skeuomorphic token contract', () => {
    const ambientCss = read('src/ambient.css');
    for (const token of [
      '--amb-control-bg',
      '--amb-control-text',
      '--amb-control-border',
      '--amb-control-shadow',
      '--amb-control-inset',
      '--amb-control-active-bg',
      '--amb-control-active-text',
      '--amb-control-disabled-opacity',
    ]) {
      expect(ambientCss).toContain(token);
    }

    for (const file of [
      'src/components/ambient/AmbientButton.tsx',
      'src/components/ambient/AmbientInput.tsx',
      'src/components/ambient/AmbientSelect.tsx',
      'src/components/ambient/AmbientTextarea.tsx',
    ]) {
      const owner = read(file);
      expect(owner).toContain('var(--amb-control-bg');
      expect(owner).toContain('var(--amb-control-text');
      expect(owner).toContain('var(--amb-control-border');
    }
  });

  it('defines complete ambient tokens for both light and black skins', () => {
    const ambientCss = read('src/ambient.css');
    const skinBlock = (skin: 'light' | 'black') => {
      const selector = `[data-terminal-shell-skin="${skin}"] {`;
      let start = ambientCss.indexOf(selector);
      while (start >= 0) {
        const end = ambientCss.indexOf('}', start);
        const block = ambientCss.slice(start, end);
        if (block.includes('--amb-light-x:')) {
          return block;
        }
        start = ambientCss.indexOf(selector, start + selector.length);
      }
      expect(start, `missing ${skin} ambient token block`).toBeGreaterThanOrEqual(0);
      const end = ambientCss.indexOf('}', start);
      expect(end, `unterminated ${skin} skin token block`).toBeGreaterThan(start);
      return ambientCss.slice(start, end);
    };

    for (const skin of ['light', 'black'] as const) {
      const block = skinBlock(skin);
      for (const token of [
        '--amb-light-x',
        '--amb-key-light-intensity',
        '--amb-fill-light-intensity',
        '--amb-light-hue',
        '--amb-albedo',
        '--amb-mat-roughness',
      ]) {
        expect(block, `${skin} skin missing ${token}`).toContain(`${token}:`);
      }
    }
  });

  it('shows focus rings only after keyboard tab navigation', () => {
    const indexCss = read('src/index.css');
    for (const selector of ['button', '[role="button"]', 'input', 'textarea', 'select', 'a', 'summary', 'label']) {
      expect(indexCss).toContain(
        `[data-zterm-input-modality="keyboard"] ${selector}:focus-visible`,
      );
    }
    for (const selector of [
      '.zterm-neo-header button',
      '.zterm-neo-quickbar > button',
      '.zterm-neo-quickbar [data-quickbar-shell-row="true"] button',
    ]) {
      expect(indexCss).toContain(
        `[data-zterm-input-modality="keyboard"] ${selector}:focus-visible`,
      );
      expect(indexCss).not.toMatch(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:focus-visible`, 'm'));
    }
    expect(read('src/main.tsx')).toContain('installInputModalityRuntime();');
  });

  it('keeps the black skin on a layered graphite ramp instead of flat black', () => {
    const indexCss = read('src/index.css');
    const blackStart = indexCss.indexOf('[data-terminal-shell-skin="black"] {');
    expect(blackStart).toBeGreaterThanOrEqual(0);
    const blackEnd = indexCss.indexOf('}', blackStart);
    const blackBlock = indexCss.slice(blackStart, blackEnd);

    const tokenValue = (name: string) => {
      const match = blackBlock.match(new RegExp(`--${name}: (#[0-9a-f]{6});`));
      expect(match, `missing --${name}`).not.toBeNull();
      return match?.[1] ?? '';
    };
    const relativeLuminance = (hex: string) => {
      const linear = [1, 3, 5].map((offset) => {
        const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };

    const ramp = ['shell-bg', 'stage-bg', 'panel-bg', 'panel-surface', 'panel-active'].map((tier) => ({
      tier,
      value: tokenValue(`zterm-${tier}`),
    }));
    for (const step of ramp) {
      expect(step.value, `${step.tier} must stay off pure black`).not.toBe('#000000');
    }
    for (let index = 1; index < ramp.length; index += 1) {
      const previous = relativeLuminance(ramp[index - 1].value);
      const current = relativeLuminance(ramp[index].value);
      expect(current, `${ramp[index].tier} must read above ${ramp[index - 1].tier}`).toBeGreaterThan(
        previous * 1.15,
      );
    }
    expect(relativeLuminance(ramp[0].value), 'black shell must be deeper than the previous graphite tier').toBeLessThan(
      relativeLuminance('#16191f'),
    );
    expect(blackBlock).toContain('--zterm-neo-raised-bg: linear-gradient(');
    expect(blackBlock).toContain('--zterm-neo-header-bg: linear-gradient(');
    expect(read('src/lib/mobile-ui.ts')).toContain("background: '#16191f'");
    expect(read('src/lib/mobile-ui.ts')).toContain("surface: '#20252d'");
  });

  it('keeps quickbar and the floating panel on ambient tokens without local color literals', () => {
    const quickBar = read('src/components/terminal/TerminalQuickBar.tsx');
    expect(quickBar).toContain('className="ambient ambient-control amb-surface zterm-neo-quickbar"');
    expect(quickBar).toContain(
      'className="ambient ambient-control amb-surface zterm-quick-input-panel"',
    );
    expect(quickBar).toContain('var(--amb-panel-bg)');
    expect(quickBar).not.toContain('mobileTheme');
    expect(quickBar).not.toMatch(/\brgba\s*\(/);
  });

  it('owns the black ambient material and panel tiers in ambient.css', () => {
    const ambientCss = read('src/ambient.css');
    const indexCss = read('src/index.css');
    const blackStart = ambientCss.indexOf('[data-terminal-shell-skin="black"] {');
    expect(blackStart).toBeGreaterThanOrEqual(0);
    const blackEnd = ambientCss.indexOf('}', blackStart);
    const blackBlock = ambientCss.slice(blackStart, blackEnd);

    for (const token of [
      '--amb-panel-bg',
      '--amb-panel-surface',
      '--amb-panel-active',
      '--amb-panel-text',
      '--amb-panel-muted',
      '--amb-panel-border',
      '--amb-panel-accent',
      '--amb-panel-accent-soft',
      '--amb-panel-accent-border',
      '--amb-panel-danger',
      '--amb-panel-danger-soft',
      '--amb-panel-shadow',
    ]) {
      expect(blackBlock, `black ambient block missing ${token}`).toContain(`${token}:`);
    }
    expect(blackBlock).toContain('--amb-albedo:color(srgb-linear .085 .10 .125)');
    expect(indexCss).not.toContain('--amb-albedo:');
  });
});
