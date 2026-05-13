import type {
  BufferHeadPayload,
  Host,
  HostConfigMessage,
  TerminalBufferPayload,
  TerminalCell,
  TerminalCursorState,
} from '../lib/types';
import { normalizeWireLines } from '../lib/terminal-buffer';

function normalizeTerminalCellRow(input: unknown): TerminalCell[] {
  if (typeof input === 'string') {
    return Array.from(input).map((char) => ({
      char: char.codePointAt(0) || 32,
      fg: 256,
      bg: 256,
      flags: 0,
      width: 1,
    }));
  }

  if (!Array.isArray(input)) {
    return [];
  }

  return input
    .filter((cell): cell is TerminalCell => Boolean(cell && typeof cell === 'object'))
    .map((cell) => ({
      char: typeof cell.char === 'number' ? cell.char : 32,
      fg: typeof cell.fg === 'number' ? cell.fg : 256,
      bg: typeof cell.bg === 'number' ? cell.bg : 256,
      flags: typeof cell.flags === 'number' ? cell.flags : 0,
      width: typeof cell.width === 'number' ? cell.width : 1,
    }));
}

export function normalizeTerminalCursorState(
  input: TerminalBufferPayload['cursor'] | BufferHeadPayload['cursor'],
): TerminalCursorState | null {
  return input && typeof input === 'object'
    ? {
        rowIndex: typeof input.rowIndex === 'number' && Number.isFinite(input.rowIndex)
          ? Math.max(0, Math.floor(input.rowIndex))
          : 0,
        col: typeof input.col === 'number' && Number.isFinite(input.col)
          ? Math.max(0, Math.floor(input.col))
          : 0,
        visible: Boolean(input.visible),
      }
    : null;
}

export function normalizeIncomingBufferPayload(input: TerminalBufferPayload): TerminalBufferPayload {
  const startIndex =
    typeof input.startIndex === 'number' && Number.isFinite(input.startIndex)
      ? Math.max(0, Math.floor(input.startIndex))
      : 0;
  const endIndex =
    typeof input.endIndex === 'number' && Number.isFinite(input.endIndex)
      ? Math.max(startIndex, Math.floor(input.endIndex))
      : startIndex;
  const rows =
    typeof input.rows === 'number' && Number.isFinite(input.rows)
      ? Math.max(1, Math.floor(input.rows))
      : 24;
  const cols =
    typeof input.cols === 'number' && Number.isFinite(input.cols)
      ? Math.max(1, Math.floor(input.cols))
      : 80;

  return {
    revision:
      typeof input.revision === 'number' && Number.isFinite(input.revision)
        ? input.revision
        : 0,
    startIndex,
    endIndex,
    availableStartIndex:
      typeof input.availableStartIndex === 'number' && Number.isFinite(input.availableStartIndex)
        ? Math.max(0, Math.floor(input.availableStartIndex))
        : undefined,
    availableEndIndex:
      typeof input.availableEndIndex === 'number' && Number.isFinite(input.availableEndIndex)
        ? Math.max(startIndex, Math.floor(input.availableEndIndex))
        : undefined,
    cols,
    rows,
    cursorKeysApp: Boolean(input.cursorKeysApp),
    cursor: normalizeTerminalCursorState(input.cursor),
    lines: Array.isArray(input.lines)
      ? normalizeWireLines(input.lines, cols).map((line) => ({
          index: line.index,
          cells: normalizeTerminalCellRow(line.cells),
        }))
      : [],
  };
}

export function buildHostConfigMessage(
  host: Host,
  sessionName: string,
  openRequestId: string,
  sessionTransportToken?: string | null,
  geometry?: { cols?: number | null; rows?: number | null; widthMode?: 'adaptive-phone' | 'mirror-fixed' } | null,
): HostConfigMessage {
  return {
    openRequestId,
    sessionTransportToken: sessionTransportToken?.trim() || undefined,
    sessionName,
    cols: Number.isFinite(geometry?.cols) ? Math.max(1, Math.floor(geometry?.cols || 0)) : undefined,
    rows: undefined,
    widthMode: geometry?.widthMode === 'adaptive-phone' ? 'adaptive-phone' : 'mirror-fixed',
    autoCommand: host.autoCommand,
  };
}
