import type { TerminalCell } from '../connection/types';
import { DEFAULT_TERMINAL_COLOR, packedTruecolorToCss } from './color';
import type { TerminalThemePreset } from './theme';

const FLAG_REVERSE = 0x20;
const FLAG_DIM = 0x02;
const BLOCK_SHADE_CODEPOINT_MIN = 0x2580;
const BLOCK_SHADE_CODEPOINT_MAX = 0x259f;
const XTERM_6X6_STEPS = [0, 95, 135, 175, 215, 255] as const;
const MIN_NEUTRAL_FOREGROUND_CONTRAST = 4.5;
const MIN_DIMMED_FOREGROUND_CONTRAST = 3;
const NEUTRAL_CHANNEL_SPREAD = 18;
const CONTRAST_SEARCH_STEPS = 12;

export const DEFAULT_TERMINAL_CELL_COLOR = DEFAULT_TERMINAL_COLOR;

export function normalizeTerminalCell(cell: TerminalCell | null | undefined): TerminalCell {
  return {
    char: typeof cell?.char === 'number' && Number.isFinite(cell.char) ? cell.char : 32,
    fg: typeof cell?.fg === 'number' && Number.isFinite(cell.fg) ? cell.fg : DEFAULT_TERMINAL_CELL_COLOR,
    bg: typeof cell?.bg === 'number' && Number.isFinite(cell.bg) ? cell.bg : DEFAULT_TERMINAL_CELL_COLOR,
    flags: typeof cell?.flags === 'number' && Number.isFinite(cell.flags) ? cell.flags : 0,
    width: cell?.width === 0 || cell?.width === 2 ? cell.width : 1,
  };
}

export function safeTerminalCodePointToString(code: number) {
  if (!Number.isInteger(code) || code < 32 || code > 0x10ffff) {
    return ' ';
  }
  try {
    return String.fromCodePoint(code);
  } catch (error) {
    console.warn('[terminal-cell-render] Failed to render code point:', { code, error });
    return ' ';
  }
}

export function terminalColorToCss(index: number, theme: TerminalThemePreset): string | null {
  if (index === DEFAULT_TERMINAL_CELL_COLOR) {
    return null;
  }
  const packedTruecolor = packedTruecolorToCss(index);
  if (packedTruecolor) {
    return packedTruecolor;
  }
  if (index < 16) {
    return theme.colors[index] || theme.foreground;
  }
  if (index < 232) {
    const n = index - 16;
    const r = XTERM_6X6_STEPS[Math.floor(n / 36)] ?? 0;
    const g = XTERM_6X6_STEPS[Math.floor(n / 6) % 6] ?? 0;
    const b = XTERM_6X6_STEPS[n % 6] ?? 0;
    return `rgb(${r},${g},${b})`;
  }
  const level = (index - 232) * 10 + 8;
  return `rgb(${level},${level},${level})`;
}

export function parseCssColorToRgb(color: string, fallback: string): [number, number, number] {
  const candidate = (color || '').trim() || fallback.trim();
  if (candidate.startsWith('#')) {
    const normalized = candidate.slice(1);
    const hex = normalized.length === 3
      ? normalized.split('').map((part) => `${part}${part}`).join('')
      : normalized;
    if (hex.length === 6) {
      return [
        Number.parseInt(hex.slice(0, 2), 16) || 0,
        Number.parseInt(hex.slice(2, 4), 16) || 0,
        Number.parseInt(hex.slice(4, 6), 16) || 0,
      ];
    }
  }

  const rgbMatch = candidate.match(/^rgb\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)\s*\)$/i);
  if (rgbMatch) {
    return [
      Number.parseInt(rgbMatch[1] || '0', 10) || 0,
      Number.parseInt(rgbMatch[2] || '0', 10) || 0,
      Number.parseInt(rgbMatch[3] || '0', 10) || 0,
    ];
  }

  if (candidate === 'transparent') {
    return parseCssColorToRgb(fallback, fallback);
  }

  return parseCssColorToRgb(fallback, fallback);
}

export function mixCssColors(fg: string, bg: string, fgRatio: number, fallbackBg: string) {
  const [fr, fgGreen, fb] = parseCssColorToRgb(fg, fallbackBg);
  const [br, bgGreen, bb] = parseCssColorToRgb(bg, fallbackBg);
  const mix = (front: number, back: number) => Math.round((front * fgRatio) + (back * (1 - fgRatio)));
  return `rgb(${mix(fr, br)},${mix(fgGreen, bgGreen)},${mix(fb, bb)})`;
}

function isDarkCssColor(color: string, fallback: string) {
  const [red, green, blue] = parseCssColorToRgb(color, fallback);
  return (red * 299 + green * 587 + blue * 114) < 145000;
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

function contrastRatio(foreground: string, background: string, fallbackBackground: string) {
  const foregroundLuminance = relativeLuminance(foreground, fallbackBackground);
  const backgroundLuminance = relativeLuminance(background, fallbackBackground);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function isNeutralCssColor(color: string, fallback: string) {
  const channels = parseCssColorToRgb(color, fallback);
  return Math.max(...channels) - Math.min(...channels) <= NEUTRAL_CHANNEL_SPREAD;
}

function mixTowardMinimumContrast(
  color: string,
  contrastAnchor: string,
  background: string,
  fallbackBackground: string,
  minimumContrast: number,
) {
  if (contrastRatio(color, background, fallbackBackground) >= minimumContrast) {
    return color;
  }
  const anchorCandidates = [contrastAnchor, '#000000', '#ffffff'];
  const readableAnchor = anchorCandidates.find((candidate) => (
    contrastRatio(candidate, background, fallbackBackground) >= minimumContrast
  ));
  if (!readableAnchor) {
    return color;
  }

  let lowerAnchorRatio = 0;
  let upperAnchorRatio = 1;
  for (let step = 0; step < CONTRAST_SEARCH_STEPS; step += 1) {
    const anchorRatio = (lowerAnchorRatio + upperAnchorRatio) / 2;
    const candidate = mixCssColors(readableAnchor, color, anchorRatio, fallbackBackground);
    if (contrastRatio(candidate, background, fallbackBackground) >= minimumContrast) {
      upperAnchorRatio = anchorRatio;
    } else {
      lowerAnchorRatio = anchorRatio;
    }
  }
  return mixCssColors(readableAnchor, color, upperAnchorRatio, fallbackBackground);
}

function resolveReadableNeutralForeground(
  foreground: string,
  background: string,
  theme: TerminalThemePreset,
) {
  const effectiveBackground = background === 'transparent' ? theme.background : background;
  if (!isNeutralCssColor(foreground, theme.foreground)) {
    return foreground;
  }
  return mixTowardMinimumContrast(
    foreground,
    theme.foreground,
    effectiveBackground,
    theme.background,
    MIN_NEUTRAL_FOREGROUND_CONTRAST,
  );
}

export function resolveTerminalCellColors(
  inputCell: TerminalCell,
  theme: TerminalThemePreset,
  options?: { cursorActive?: boolean },
) {
  const cell = normalizeTerminalCell(inputCell);
  let fg = cell.fg;
  let bg = cell.bg;
  const reverse = Boolean(cell.flags & FLAG_REVERSE) || Boolean(options?.cursorActive);

  if (reverse) {
    [fg, bg] = [bg, fg];
  }

  const resolvedBackground = bg === DEFAULT_TERMINAL_CELL_COLOR
    ? (reverse ? theme.foreground : 'transparent')
    : terminalColorToCss(bg, theme) || 'transparent';
  const rawForeground = fg === DEFAULT_TERMINAL_CELL_COLOR
    ? (reverse
      ? theme.background
      : bg !== DEFAULT_TERMINAL_CELL_COLOR && isDarkCssColor(resolvedBackground, theme.background)
        ? theme.colors[15]
        : theme.foreground)
    : terminalColorToCss(fg, theme) || theme.foreground;
  const resolvedForeground = resolveReadableNeutralForeground(rawForeground, resolvedBackground, theme);

  return {
    fg: resolvedForeground,
    bg: resolvedBackground,
  };
}

export function resolveDimmedTerminalForeground(fg: string, bg: string, themeBackground: string) {
  const effectiveBackground = bg === 'transparent' ? themeBackground : bg;
  const dimmedForeground = mixCssColors(fg, effectiveBackground, 0.5, themeBackground);
  return mixTowardMinimumContrast(
    dimmedForeground,
    fg,
    effectiveBackground,
    themeBackground,
    MIN_DIMMED_FOREGROUND_CONTRAST,
  );
}

export function resolveRenderedTerminalForeground(
  inputCell: TerminalCell,
  theme: TerminalThemePreset,
  options?: { cursorActive?: boolean },
) {
  const cell = normalizeTerminalCell(inputCell);
  const colors = resolveTerminalCellColors(cell, theme, options);
  return (cell.flags & FLAG_DIM)
    ? resolveDimmedTerminalForeground(colors.fg, colors.bg, theme.background)
    : colors.fg;
}

export function isBlockShadeCodePoint(code: number) {
  return Number.isInteger(code) && code >= BLOCK_SHADE_CODEPOINT_MIN && code <= BLOCK_SHADE_CODEPOINT_MAX;
}

export function buildBlockBackground(code: number, fg: string, bg: string, themeBackground: string) {
  switch (code) {
    case 0x2580:
      return `linear-gradient(${fg} 50%,${bg} 50%)`;
    case 0x2581:
      return `linear-gradient(${bg} 87.5%,${fg} 87.5%)`;
    case 0x2582:
      return `linear-gradient(${bg} 75%,${fg} 75%)`;
    case 0x2583:
      return `linear-gradient(${bg} 62.5%,${fg} 62.5%)`;
    case 0x2584:
      return `linear-gradient(${bg} 50%,${fg} 50%)`;
    case 0x2585:
      return `linear-gradient(${bg} 37.5%,${fg} 37.5%)`;
    case 0x2586:
      return `linear-gradient(${bg} 25%,${fg} 25%)`;
    case 0x2587:
      return `linear-gradient(${bg} 12.5%,${fg} 12.5%)`;
    case 0x2588:
      return fg;
    case 0x2589:
      return `linear-gradient(to right,${fg} 87.5%,${bg} 87.5%)`;
    case 0x258a:
      return `linear-gradient(to right,${fg} 75%,${bg} 75%)`;
    case 0x258b:
      return `linear-gradient(to right,${fg} 62.5%,${bg} 62.5%)`;
    case 0x258c:
      return `linear-gradient(to right,${fg} 50%,${bg} 50%)`;
    case 0x258d:
      return `linear-gradient(to right,${fg} 37.5%,${bg} 37.5%)`;
    case 0x258e:
      return `linear-gradient(to right,${fg} 25%,${bg} 25%)`;
    case 0x258f:
      return `linear-gradient(to right,${fg} 12.5%,${bg} 12.5%)`;
    case 0x2590:
      return `linear-gradient(to right,${bg} 50%,${fg} 50%)`;
    case 0x2591:
      return mixCssColors(fg, bg, 0.25, themeBackground);
    case 0x2592:
      return mixCssColors(fg, bg, 0.5, themeBackground);
    case 0x2593:
      return mixCssColors(fg, bg, 0.75, themeBackground);
    case 0x2594:
      return `linear-gradient(${fg} 12.5%,${bg} 12.5%)`;
    case 0x2595:
      return `linear-gradient(to right,${bg} 87.5%,${fg} 87.5%)`;
    default: {
      const quadrants: Record<number, [boolean, boolean, boolean, boolean]> = {
        0x2596: [false, false, true, false],
        0x2597: [false, false, false, true],
        0x2598: [true, false, false, false],
        0x2599: [true, false, true, true],
        0x259a: [true, false, false, true],
        0x259b: [true, true, true, false],
        0x259c: [true, true, false, true],
        0x259d: [false, true, false, false],
        0x259e: [false, true, true, false],
        0x259f: [false, true, true, true],
      };
      const quadrantFill = quadrants[code];
      if (!quadrantFill) {
        return fg;
      }
      const [topLeft, topRight, bottomLeft, bottomRight] = quadrantFill;
      if (topLeft && topRight && bottomLeft && bottomRight) {
        return fg;
      }
      const layers: string[] = [];
      const positions = ['0 0', '100% 0', '0 100%', '100% 100%'];
      quadrantFill.forEach((filled, index) => {
        if (!filled) {
          return;
        }
        layers.push(`linear-gradient(${fg},${fg}) ${positions[index]}/50% 50% no-repeat`);
      });
      layers.push(bg);
      return layers.join(',');
    }
  }
}

export function isSolidBlockBackground(background: string) {
  return !background.includes('gradient(');
}
