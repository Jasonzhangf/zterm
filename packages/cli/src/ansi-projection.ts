import type { TerminalCell } from '../../shared/src/connection/types.js';
import {
  DEFAULT_TERMINAL_COLOR,
  decodePackedTruecolorColor,
} from '../../shared/src/terminal/color.js';
import {
  parseCssColorToRgb,
} from '../../shared/src/terminal/cell-render.js';
import {
  getTerminalThemePreset,
  type TerminalThemePreset,
} from '../../shared/src/terminal/theme.js';
import type {
  RendererCursorProjection,
  RendererSnapshot,
  RendererVisibleRow,
} from './renderer-window.js';

const FLAG_BOLD = 0x01;
const FLAG_DIM = 0x02;
const FLAG_ITALIC = 0x04;
const FLAG_UNDERLINE = 0x08;
const FLAG_REVERSE = 0x20;
const FLAG_INVISIBLE = 0x40;
const FLAG_STRIKETHROUGH = 0x80;
const XTERM_6X6_STEPS = [0, 95, 135, 175, 215, 255] as const;

export interface AnsiOutputTarget {
  write(data: string): boolean;
}

export interface AnsiProjectionOptions {
  write(data: string): boolean;
  theme?: TerminalThemePreset | string;
}

export interface AnsiProjectionCommit {
  wrote: boolean;
  blocked: boolean;
  pending: boolean;
}

export interface AnsiProjection {
  commit(snapshot: RendererSnapshot): AnsiProjectionCommit;
  resume(): Promise<AnsiProjectionCommit>;
  restore(): Promise<void>;
}

interface RenderState {
  rows: readonly RendererVisibleRow[];
  rowCount: number;
  cursor: RendererCursorProjection | null;
}

function resolveTheme(theme: TerminalThemePreset | string | undefined) {
  return typeof theme === 'string'
    ? getTerminalThemePreset(theme)
    : theme || getTerminalThemePreset();
}

function resolveRgbColor(index: number, theme: TerminalThemePreset): [number, number, number] | null {
  if (!Number.isFinite(index) || index === DEFAULT_TERMINAL_COLOR) return null;
  const packed = decodePackedTruecolorColor(index);
  if (packed) return packed;

  const safeIndex = Math.max(0, Math.min(255, Math.floor(index)));
  if (safeIndex < 16) {
    return parseCssColorToRgb(theme.colors[safeIndex] || theme.foreground, theme.foreground);
  }
  if (safeIndex < 232) {
    const cubeIndex = safeIndex - 16;
    return [
      XTERM_6X6_STEPS[Math.floor(cubeIndex / 36)] ?? 0,
      XTERM_6X6_STEPS[Math.floor(cubeIndex / 6) % 6] ?? 0,
      XTERM_6X6_STEPS[cubeIndex % 6] ?? 0,
    ];
  }
  const level = (safeIndex - 232) * 10 + 8;
  return [level, level, level];
}

function colorParameters(index: number, theme: TerminalThemePreset, background: boolean) {
  const rgb = resolveRgbColor(index, theme);
  if (!rgb) return [background ? 49 : 39];
  return [background ? 48 : 38, 2, rgb[0], rgb[1], rgb[2]];
}

function safeCellText(cell: TerminalCell) {
  const codePoint = cell.char;
  if (
    !Number.isInteger(codePoint)
    || codePoint < 0x20
    || codePoint === 0x7f
    || (codePoint >= 0x80 && codePoint <= 0x9f)
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)
    || codePoint > 0x10ffff
  ) {
    return ' ';
  }
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return ' ';
  }
}

function cellSgr(cell: TerminalCell, theme: TerminalThemePreset) {
  const parameters = [
    0,
    ...colorParameters(cell.fg, theme, false),
    ...colorParameters(cell.bg, theme, true),
  ];
  if (cell.flags & FLAG_BOLD) parameters.push(1);
  if (cell.flags & FLAG_DIM) parameters.push(2);
  if (cell.flags & FLAG_ITALIC) parameters.push(3);
  if (cell.flags & FLAG_UNDERLINE) parameters.push(4);
  if (cell.flags & FLAG_REVERSE) parameters.push(7);
  if (cell.flags & FLAG_INVISIBLE) parameters.push(8);
  if (cell.flags & FLAG_STRIKETHROUGH) parameters.push(9);
  return `\x1b[${parameters.join(';')}m`;
}

function cellsEqual(left: readonly TerminalCell[], right: readonly TerminalCell[]) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      !a
      || !b
      || a.char !== b.char
      || a.fg !== b.fg
      || a.bg !== b.bg
      || a.flags !== b.flags
      || a.width !== b.width
    ) {
      return false;
    }
  }
  return true;
}

function rowsEqual(left: RendererVisibleRow, right: RendererVisibleRow | undefined) {
  return Boolean(
    right
    && left.absoluteIndex === right.absoluteIndex
    && left.gap === right.gap
    && cellsEqual(left.cells, right.cells),
  );
}

function cursorEqual(
  left: RendererCursorProjection | null,
  right: RendererCursorProjection | null,
) {
  if (!left || !right) return left === right;
  return (
    left.visible === right.visible
    && left.screenRow === right.screenRow
    && left.screenCol === right.screenCol
  );
}

function renderRow(
  row: RendererVisibleRow,
  theme: TerminalThemePreset,
) {
  const parts = [
    `\x1b[${row.screenRow + 1};1H`,
    '\x1b[2K',
    '\x1b[0m',
  ];
  for (const cell of row.cells) {
    if (cell.width === 0) continue;
    const text = safeCellText(cell);
    parts.push(
      cellSgr(cell, theme),
      cell.width === 2 && text === ' ' ? '  ' : text,
    );
  }
  parts.push('\x1b[0m');
  return parts.join('');
}

function cursorFrame(cursor: RendererCursorProjection | null) {
  if (!cursor?.visible || cursor.screenRow === null || cursor.screenCol === null) {
    return '\x1b[?25l';
  }
  return `\x1b[?25h\x1b[${cursor.screenRow + 1};${cursor.screenCol + 1}H`;
}

function buildRenderFrame(
  snapshot: RendererSnapshot,
  previous: RenderState | null,
  theme: TerminalThemePreset,
) {
  const rowCountChanged = previous?.rowCount !== snapshot.rows.length;
  const parts: string[] = [];
  if (rowCountChanged) {
    parts.push('\x1b[2J');
  }

  for (const row of snapshot.rows) {
    const previousRow = previous?.rows[row.screenRow];
    if (!rowsEqual(row, previousRow)) {
      parts.push(renderRow(row, theme));
    }
  }

  if (!previous || !cursorEqual(previous.cursor, snapshot.cursor)) {
    parts.push(cursorFrame(snapshot.cursor));
  }

  return {
    data: parts.join(''),
    next: {
      rows: snapshot.rows,
      rowCount: snapshot.rows.length,
      cursor: snapshot.cursor,
    } satisfies RenderState,
  };
}

export function createAnsiProjection(options: AnsiProjectionOptions): AnsiProjection {
  const target: AnsiOutputTarget = { write: options.write };
  const theme = resolveTheme(options.theme);
  let rendered: RenderState | null = null;
  let pending: RendererSnapshot | null = null;
  let blocked = false;

  function drain(): AnsiProjectionCommit {
    let wrote = false;
    while (pending) {
      const snapshot = pending;
      pending = null;
      const frame = buildRenderFrame(snapshot, rendered, theme);
      if (!frame.data) continue;
      const accepted = target.write(frame.data);
      wrote = true;
      rendered = frame.next;
      if (!accepted) {
        blocked = true;
        return {
          wrote: true,
          blocked: true,
          pending: pending !== null,
        };
      }
    }

    blocked = false;
    return {
      wrote,
      blocked: false,
      pending: pending !== null,
    };
  }

  return {
    commit(snapshot) {
      pending = snapshot;
      if (blocked) {
        return {
          wrote: false,
          blocked: true,
          pending: true,
        };
      }
      return drain();
    },
    async resume() {
      blocked = false;
      return drain();
    },
    async restore() {
      pending = null;
      blocked = false;
      rendered = null;
      target.write('\x1b[0m\x1b[?25h');
    },
  };
}
