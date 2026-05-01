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
      parserBridge.writeString(line);
    }
    canonicalLines.push(readVisibleRow(parserBridge, 0));
  }

  return canonicalLines;
}
