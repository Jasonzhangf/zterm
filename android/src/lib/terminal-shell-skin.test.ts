import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  resolveEffectiveTerminalShellSkin,
  resolveNextTerminalShellBoundaryDelayMs,
  resolveTerminalRendererThemeForSkin,
} from './terminal-shell-skin';

describe('terminal shell skin resolution', () => {
  it('keeps explicit light, blue, and black selections', () => {
    expect(resolveEffectiveTerminalShellSkin('light', new Date('2026-08-03T23:00:00'))).toBe('light');
    expect(resolveEffectiveTerminalShellSkin('blue', new Date('2026-08-03T12:00:00'))).toBe('blue');
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
    expect(resolveTerminalRendererThemeForSkin('default', 'blue')).toBe('tabby-cobalt2');
    expect(resolveTerminalRendererThemeForSkin('classic-dark', 'black')).toBe('classic-dark');
    expect(resolveTerminalRendererThemeForSkin('gruvbox-dark', 'light')).toBe('gruvbox-dark');
  });

  it('defines one shared panel token contract for every shell skin', () => {
    const css = readFileSync(new URL('../index.css', import.meta.url), 'utf8');
    for (const selector of [
      '.zterm-terminal-shell {',
      '.zterm-terminal-shell[data-terminal-shell-skin="blue"] {',
      '.zterm-terminal-shell[data-terminal-shell-skin="black"] {',
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
    }
    expect(css).toContain('.zterm-neo-drawer');
    expect(css).toContain('.zterm-connection-route-menu');
    expect(css).toContain('.zterm-neo-quickbar[data-quickbar-surface="expanded"]');
  });
});
