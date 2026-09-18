import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveTerminalShellSkin,
  resolveNextTerminalShellBoundaryDelayMs,
  resolveTerminalRendererThemeForSkin,
} from './terminal-shell-skin';

describe('terminal shell skin resolution', () => {
  it('keeps explicit light and black selections and folds legacy blue into black', () => {
    expect(resolveEffectiveTerminalShellSkin('light', new Date('2026-08-03T23:00:00'))).toBe('light');
    expect(resolveEffectiveTerminalShellSkin('blue', new Date('2026-08-03T12:00:00'))).toBe('black');
    expect(resolveEffectiveTerminalShellSkin('black', new Date('2026-08-03T12:00:00'))).toBe('black');
  });

  it('uses local sunrise/sunset window for auto skin', () => {
    expect(resolveEffectiveTerminalShellSkin('auto', new Date('2026-08-03T08:00:00'))).toBe('light');
    expect(resolveEffectiveTerminalShellSkin('auto', new Date('2026-08-03T21:00:00'))).toBe('black');
  });

  it('schedules auto skin updates only at the next day/night boundary', () => {
    expect(resolveNextTerminalShellBoundaryDelayMs(new Date('2026-08-03T05:00:00'))).toBe(60 * 60 * 1000);
    expect(resolveNextTerminalShellBoundaryDelayMs(new Date('2026-08-03T08:00:00'))).toBe(10 * 60 * 60 * 1000);
    expect(resolveNextTerminalShellBoundaryDelayMs(new Date('2026-08-03T21:00:00'))).toBe(9 * 60 * 60 * 1000);
  });

  it('maps default renderer theme to the effective shell skin', () => {
    expect(resolveTerminalRendererThemeForSkin('classic-dark', 'light')).toBe('tabby-pencil-light');
    expect(resolveTerminalRendererThemeForSkin('default', 'light')).toBe('tabby-pencil-light');
    // The black shell must not fall back to the pure-black classic-dark canvas.
    expect(resolveTerminalRendererThemeForSkin('default', 'black')).toBe('one-dark');
    expect(resolveTerminalRendererThemeForSkin('classic-dark', 'black')).toBe('one-dark');
    expect(resolveTerminalRendererThemeForSkin('gruvbox-dark', 'light')).toBe('gruvbox-dark');
  });

  it('defines one shared panel token contract for every shell skin', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    for (const selector of [
      '.zterm-terminal-shell,\n[data-terminal-shell-skin] {',
      '[data-terminal-shell-skin="black"] {',
    ]) {
      const start = css.indexOf(selector);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = css.indexOf('}', start);
      const block = css.slice(start, end);
      expect(block).toContain('--zterm-panel-bg:');
      expect(block).toContain('--zterm-panel-surface:');
      expect(block).toContain('--zterm-panel-text:');
      expect(block).toContain('--zterm-panel-muted:');
      expect(block).toContain('--zterm-panel-border:');
      expect(block).toContain('--zterm-neo-raised-bg:');
      expect(block).toContain('--zterm-neo-text-shadow:');
    }
    const blackStart = css.indexOf('[data-terminal-shell-skin="black"] {');
    const blackEnd = css.indexOf('}', blackStart);
    const blackBlock = css.slice(blackStart, blackEnd);
    expect(blackBlock).toContain('--zterm-neo-raised-bg: linear-gradient(');
    expect(blackBlock).toContain('--zterm-neo-highlight: rgba(255, 255, 255, 0.26);');
    expect(css).toContain('.zterm-neo-drawer');
    expect(css).toContain('.zterm-connection-route-menu');
    expect(css).toContain('.zterm-neo-quickbar[data-quickbar-surface="expanded"]');
    expect(css).toContain('text-shadow: var(--zterm-skeu-text-shadow) !important;');
    expect(css).not.toContain('0 -1px 0 rgba(31, 35, 40, 0.24),');
  });

  it('keeps the black ambient panel deeper than the previous graphite tier', () => {
    const ambientCss = readFileSync(new URL('../ambient.css', import.meta.url), 'utf8');
    const blackStart = ambientCss.indexOf('[data-terminal-shell-skin="black"] {');
    expect(blackStart).toBeGreaterThanOrEqual(0);
    const blackEnd = ambientCss.indexOf('}', blackStart);
    const blackBlock = ambientCss.slice(blackStart, blackEnd);

    const tokenValue = (name: string) => {
      const match = blackBlock.match(new RegExp(`--${name}:(#[0-9a-f]{6});`));
      expect(match, `missing --${name}`).not.toBeNull();
      return match?.[1] ?? '';
    };
    const luminance = (hex: string) => {
      const linear = [1, 3, 5].map((offset) => {
        const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
    };

    const panelBg = tokenValue('amb-panel-bg');
    const panelSurface = tokenValue('amb-panel-surface');
    const panelText = tokenValue('amb-panel-text');
    expect(luminance(panelBg)).toBeLessThan(0.01);
    expect(luminance(panelSurface)).toBeGreaterThan(luminance(panelBg));
    expect(luminance(panelText)).toBeGreaterThan(luminance(panelBg) * 12);
    expect(blackBlock).toContain('--amb-panel-border:rgba(245,247,251,.14)');
  });
});
