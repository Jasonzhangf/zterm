import type { TerminalCell } from '../../connection/types';

export function resolveCursorCellColumn(row: TerminalCell[], preferredCol: number) {
  if (row.length === 0) return -1;
  const clamped = Math.max(0, Math.min(row.length - 1, Math.floor(preferredCol)));
  if (row[clamped]?.width !== 0) return clamped;
  for (let col = clamped - 1; col >= 0; col -= 1) {
    if (row[col]?.width !== 0) return col;
  }
  return clamped;
}

export function resolveCursorOverlay(options: {
  row: TerminalCell[];
  cursor: { rowIndex: number; col: number; visible: boolean } | null | undefined;
  absoluteIndex: number;
}) {
  if (!options.cursor || !options.cursor.visible || options.cursor.rowIndex !== options.absoluteIndex) {
    return { cursorColumn: -1, active: false };
  }
  return {
    cursorColumn: resolveCursorCellColumn(options.row, options.cursor.col),
    active: true,
  };
}

export function detectDoubleWidthChar(input: string | number | null | undefined) {
  const char = typeof input === 'number'
    ? String.fromCodePoint(input)
    : (input || '');
  if (!char) return false;
  const codePoint = char.codePointAt(0);
  if (!codePoint) return false;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f)
    || (codePoint >= 0x2329 && codePoint <= 0x232a)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faf6)
  );
}

