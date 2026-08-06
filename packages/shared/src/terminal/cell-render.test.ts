import { describe, expect, it } from 'vitest';
import type { TerminalCell } from '../connection/types';
import {
  parseCssColorToRgb,
  resolveRenderedTerminalForeground,
  resolveTerminalCellColors,
} from './cell-render';
import { encodePackedTruecolorColor } from './color';
import { getTerminalThemePreset } from './theme';

const DEFAULT_COLOR = 256;
const FLAG_DIM = 0x02;

function cell(overrides: Partial<TerminalCell>): TerminalCell {
  return {
    char: 65,
    fg: DEFAULT_COLOR,
    bg: DEFAULT_COLOR,
    flags: 0,
    width: 1,
    ...overrides,
  };
}

function relativeLuminance(color: string, fallback: string) {
  const channels = parseCssColorToRgb(color, fallback).map((channel) => {
    const normalized = channel / 255;
    return normalized <= 0.04045
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4;
  });
  return (channels[0] * 0.2126) + (channels[1] * 0.7152) + (channels[2] * 0.0722);
}

function contrastRatio(foreground: string, background: string) {
  const foregroundLuminance = relativeLuminance(foreground, background);
  const backgroundLuminance = relativeLuminance(background, background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('terminal cell neutral contrast projection', () => {
  it('darkens ANSI white on the Pencil Light background to readable gray', () => {
    const theme = getTerminalThemePreset('tabby-pencil-light');
    const colors = resolveTerminalCellColors(cell({ fg: 15 }), theme);

    expect(colors.fg).not.toBe(theme.colors[15]);
    expect(contrastRatio(colors.fg, theme.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('lightens ANSI black on the Classic Dark background to readable gray', () => {
    const theme = getTerminalThemePreset('classic-dark');
    const colors = resolveTerminalCellColors(cell({ fg: 0 }), theme);

    expect(colors.fg).not.toBe(theme.colors[0]);
    expect(contrastRatio(colors.fg, theme.background)).toBeGreaterThanOrEqual(4.5);
  });

  it('does not change low-contrast neutral text to match an explicit cell background', () => {
    const theme = getTerminalThemePreset('tabby-pencil-light');
    const colors = resolveTerminalCellColors(cell({ fg: 0, bg: 8 }), theme);

    expect(colors.bg).toBe(theme.colors[8]);
    expect(colors.fg).not.toBe(colors.bg);
    expect(contrastRatio(colors.fg, colors.bg)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps dim text readable but weaker than normal text on light and dark backgrounds', () => {
    for (const themeId of ['tabby-pencil-light', 'classic-dark'] as const) {
      const theme = getTerminalThemePreset(themeId);
      const normal = resolveRenderedTerminalForeground(cell({}), theme);
      const dimmed = resolveRenderedTerminalForeground(cell({ flags: FLAG_DIM }), theme);
      const normalContrast = contrastRatio(normal, theme.background);
      const dimmedContrast = contrastRatio(dimmed, theme.background);

      expect(dimmedContrast).toBeGreaterThanOrEqual(3);
      expect(dimmedContrast).toBeLessThan(normalContrast);
    }
  });

  it('preserves saturated ANSI and sufficient-contrast truecolor foregrounds', () => {
    const theme = getTerminalThemePreset('classic-dark');
    const ansi = resolveTerminalCellColors(cell({ fg: 1 }), theme);
    const truecolor = resolveTerminalCellColors(cell({
      fg: encodePackedTruecolorColor(120, 210, 150),
    }), theme);

    expect(ansi.fg).toBe(theme.colors[1]);
    expect(truecolor.fg).toBe('rgb(120,210,150)');
  });

  it('preserves reverse foreground/background semantics', () => {
    const theme = getTerminalThemePreset('tabby-pencil-light');
    const colors = resolveTerminalCellColors(cell({ fg: 1, bg: 4, flags: 0x20 }), theme);

    expect(colors.fg).toBe(theme.colors[4]);
    expect(colors.bg).toBe(theme.colors[1]);
  });
});
