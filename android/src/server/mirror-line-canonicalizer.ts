import { WasmBridge } from '@jsonstudio/wtermmod-core';
import { encodePackedTruecolorColor } from '@zterm/shared/terminal/color';
import type { TerminalCell } from '../lib/types';
import { trimTrailingDefaultCells } from './canonical-buffer';

function serializeCell(cell: ReturnType<WasmBridge['getCell']>): TerminalCell {
  return {
    char: cell.char,
    fg: cell.fg,
    bg: cell.bg,
    flags: cell.flags,
    width: cell.width,
  };
}

function readVisibleRow(bridge: WasmBridge, row = 0) {
  const cols = bridge.getCols();
  const cells: TerminalCell[] = [];
  for (let col = 0; col < cols; col += 1) {
    cells.push(serializeCell(bridge.getCell(row, col)));
  }
  return trimTrailingDefaultCells(cells);
}

function normalizeExtendedColorToken(token: string) {
  if (!token.includes(':')) {
    return token;
  }
  const parts = token.split(':');
  if (parts.length < 3) {
    return token.split(':').join(';');
  }
  const selector = parts[0];
  const mode = parts[1];
  if ((selector === '38' || selector === '48' || selector === '58') && (mode === '2' || mode === '5')) {
    return [selector, mode, ...parts.slice(2).filter((part) => part.length > 0)].join(';');
  }
  return token.split(':').join(';');
}

function normalizeAnsiExtendedColorSeparators(line: string) {
  if (!line.includes('\x1b[') || !line.includes(':')) {
    return line;
  }
  return line.replace(/\x1b\[([0-9:;]*)m/g, (_match, params: string) => {
    const normalizedParams = params
      .split(';')
      .map((token) => normalizeExtendedColorToken(token))
      .join(';');
    return `\x1b[${normalizedParams}m`;
  });
}

function normalizeAnsiTruecolorPayload(line: string) {
  if (!line.includes('\x1b[') || (!line.includes('38;2;') && !line.includes('48;2;') && !line.includes('38:2:') && !line.includes('48:2:'))) {
    return line;
  }

  return line.replace(/\x1b\[([0-9;:]*)m/g, (match, params: string) => {
    const tokens = params.split(';').flatMap((token) => token.split(':').filter((part) => part.length > 0));
    if (tokens.length === 0) {
      return match;
    }

    const rewritten: string[] = [];
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if ((token === '38' || token === '48') && tokens[index + 1] === '2') {
        const red = Number.parseInt(tokens[index + 2] || '', 10);
        const green = Number.parseInt(tokens[index + 3] || '', 10);
        const blue = Number.parseInt(tokens[index + 4] || '', 10);
        if (
          Number.isFinite(red)
          && Number.isFinite(green)
          && Number.isFinite(blue)
        ) {
          const packed = encodePackedTruecolorColor(red, green, blue);
          rewritten.push(token === '38' ? `\u009b_zterm_fg_${packed}_m` : `\u009b_zterm_bg_${packed}_m`);
          index += 5;
          continue;
        }
      }
      rewritten.push(`\x1b[${token}m`);
      index += 1;
    }

    return rewritten.join('');
  });
}

function applyPackedTruecolorHints(line: string, cells: TerminalCell[]) {
  if (!line.includes('\u009b_zterm_')) {
    return cells;
  }

  const patched = cells.map((cell) => ({ ...cell }));
  const visibleColumns: number[] = [];
  for (let index = 0; index < patched.length; index += 1) {
    if (patched[index]?.width !== 0) {
      visibleColumns.push(index);
    }
  }

  let activeFg: number | null = null;
  let activeBg: number | null = null;
  let visibleCellCursor = 0;
  const tokenPattern = /(?:\u009b_zterm_(fg|bg)_(\d+)_m)|(?:\x1b\[0m)|(?:\x1b\[[0-9;:]*m)|([\s\S])/gu;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(line)) !== null) {
    if (match[1] && match[2]) {
      const packed = Number.parseInt(match[2], 10);
      if (Number.isFinite(packed)) {
        if (match[1] === 'fg') {
          activeFg = packed;
        } else {
          activeBg = packed;
        }
      }
      continue;
    }

    if (match[0] === '\x1b[0m') {
      activeFg = null;
      activeBg = null;
      continue;
    }

    if (match[0].startsWith('\x1b[')) {
      const params = match[0].slice(2, -1).split(';').filter((part) => part.length > 0);
      if (params.includes('0') || params.includes('39')) {
        activeFg = null;
      }
      if (params.includes('0') || params.includes('49')) {
        activeBg = null;
      }
      continue;
    }

    const char = match[3];
    if (!char) {
      continue;
    }
    const cellColumn = visibleColumns[visibleCellCursor];
    visibleCellCursor += 1;
    if (typeof cellColumn !== 'number') {
      continue;
    }
    if (activeFg !== null) {
      patched[cellColumn]!.fg = activeFg;
    }
    if (activeBg !== null) {
      patched[cellColumn]!.bg = activeBg;
    }
  }

  return patched;
}

export async function canonicalizeCapturedMirrorLines(
  capturedLines: string[],
  cols: number,
  bridge?: WasmBridge,
) {
  if (capturedLines.length === 0) {
    return [] as TerminalCell[][];
  }

  const parserBridge = bridge ?? await WasmBridge.load();
  const safeCols = Math.max(1, Math.floor(cols) || 1);
  const canonicalLines: TerminalCell[][] = [];

  for (const line of capturedLines) {
    parserBridge.init(safeCols, 1);
    if (line.length > 0) {
      parserBridge.writeString(normalizeAnsiExtendedColorSeparators(line));
    }
    const normalizedRawLine = normalizeAnsiTruecolorPayload(normalizeAnsiExtendedColorSeparators(line));
    canonicalLines.push(applyPackedTruecolorHints(normalizedRawLine, readVisibleRow(parserBridge, 0)));
  }

  return canonicalLines;
}
