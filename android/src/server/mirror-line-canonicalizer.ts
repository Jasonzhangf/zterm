import { WasmBridge } from '@jsonstudio/wtermmod-core';
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
    canonicalLines.push(readVisibleRow(parserBridge, 0));
  }

  return canonicalLines;
}
