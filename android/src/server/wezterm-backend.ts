import type { TerminalCell } from '../lib/types';
import { normalizeCapturedLineBlock, trimCanonicalBufferWindow } from './canonical-buffer';
import { canonicalizeCapturedMirrorLines } from './mirror-line-canonicalizer';

export interface WezTermPaneRecord {
  winId: number;
  tabId: number;
  paneId: number;
  workspace: string;
  cols: number;
  rows: number;
  title: string;
  cwd: string;
}

export interface WezTermMirrorSnapshot {
  revision: number;
  bufferStartIndex: number;
  bufferLines: TerminalCell[][];
  cols: number;
  rows: number;
  cursorKeysApp: false;
  cursor: null;
}

export interface WezTermInputContract {
  verified: true;
  mode: 'send-text-no-paste-stdin';
  args: string[];
  limitations: string[];
}

export interface BuildWezTermMirrorSnapshotOptions {
  pane: WezTermPaneRecord;
  revision: number;
  previousStartIndex?: number;
  previousLineCount?: number;
  getTextEscapes: string;
  maxMirrorLines?: number;
}

function parsePositiveInteger(value: string, label: string) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`invalid wezterm ${label}: ${value}`);
  }
  return parsed;
}

function parseSize(value: string) {
  const match = /^(\d+)x(\d+)$/.exec(value.trim());
  if (!match) {
    throw new Error(`invalid wezterm pane size: ${value}`);
  }
  return {
    cols: parsePositiveInteger(match[1]!, 'cols'),
    rows: parsePositiveInteger(match[2]!, 'rows'),
  };
}

export function parseWezTermPaneList(raw: string): WezTermPaneRecord[] {
  const lines = raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [];
  }
  const body = /^WINID\s+TABID\s+PANEID\s+WORKSPACE\s+SIZE\s+TITLE\s+CWD$/i.test(lines[0]!)
    ? lines.slice(1)
    : lines;

  return body.map((line) => {
    const parts = line.split(/\s+/);
    if (parts.length < 7) {
      throw new Error(`invalid wezterm pane row: ${line}`);
    }
    const [winIdRaw, tabIdRaw, paneIdRaw, workspace, sizeRaw, title, ...cwdParts] = parts;
    const size = parseSize(sizeRaw!);
    return {
      winId: parsePositiveInteger(winIdRaw!, 'winId'),
      tabId: parsePositiveInteger(tabIdRaw!, 'tabId'),
      paneId: parsePositiveInteger(paneIdRaw!, 'paneId'),
      workspace: workspace!,
      cols: size.cols,
      rows: size.rows,
      title: title!,
      cwd: cwdParts.join(' '),
    };
  });
}

function stripAnsiControlSequences(line: string) {
  return line.replace(/\x1b\[[0-9;:]*[A-Za-z]/g, '');
}

function normalizeWezTermGetTextLines(raw: string) {
  const lines = normalizeCapturedLineBlock(raw);
  let end = lines.length;
  while (end > 0 && stripAnsiControlSequences(lines[end - 1]!).trim().length === 0) {
    end -= 1;
  }
  return end === lines.length ? lines : lines.slice(0, end);
}

function resolveNextStartIndex(options: {
  previousStartIndex: number;
  previousLineCount: number;
  nextLineCount: number;
  trimmedLineCount: number;
}) {
  const previousStartIndex = Math.max(0, Math.floor(options.previousStartIndex || 0));
  const previousLineCount = Math.max(0, Math.floor(options.previousLineCount || 0));
  const nextLineCount = Math.max(0, Math.floor(options.nextLineCount || 0));
  const trimmedLineCount = Math.max(0, Math.floor(options.trimmedLineCount || 0));

  if (trimmedLineCount > 0) {
    const previousEndIndex = previousStartIndex + previousLineCount;
    const nextEndIndex = Math.max(previousEndIndex, previousStartIndex + nextLineCount);
    return Math.max(0, nextEndIndex - (nextLineCount - trimmedLineCount));
  }

  return previousStartIndex;
}

export async function buildWezTermMirrorSnapshot(
  options: BuildWezTermMirrorSnapshotOptions,
): Promise<WezTermMirrorSnapshot> {
  const maxMirrorLines = Math.max(1, Math.floor(options.maxMirrorLines || 1000));
  const rawLines = normalizeWezTermGetTextLines(options.getTextEscapes);
  const canonicalLines = await canonicalizeCapturedMirrorLines(rawLines, options.pane.cols);
  const trimmed = trimCanonicalBufferWindow(0, canonicalLines, maxMirrorLines);
  const trimmedLineCount = canonicalLines.length - trimmed.lines.length;
  const bufferStartIndex = resolveNextStartIndex({
    previousStartIndex: options.previousStartIndex || 0,
    previousLineCount: options.previousLineCount || 0,
    nextLineCount: canonicalLines.length,
    trimmedLineCount,
  });

  return {
    revision: Math.max(0, Math.floor(options.revision || 0)),
    bufferStartIndex,
    bufferLines: trimmed.lines,
    cols: options.pane.cols,
    rows: options.pane.rows,
    cursorKeysApp: false,
    cursor: null,
  };
}

export function buildWezTermSendTextArgs(paneId: number): string[] {
  const normalizedPaneId = Math.max(0, Math.floor(paneId));
  if (!Number.isFinite(normalizedPaneId) || normalizedPaneId <= 0) {
    throw new Error(`invalid wezterm paneId for input: ${paneId}`);
  }
  return ['cli', '--prefer-mux', 'send-text', '--pane-id', String(normalizedPaneId), '--no-paste'];
}

export function requireWezTermInputContract(): WezTermInputContract {
  return {
    verified: true,
    mode: 'send-text-no-paste-stdin',
    args: ['cli', '--prefer-mux', 'send-text', '--pane-id', '<paneId>', '--no-paste'],
    limitations: [
      'write raw bytes to stdin; do not pass input through shell arguments',
      'verified for Enter, Backspace/DEL, arrow escape sequences, raw-mode TUI bytes, and Codex TUI text entry',
      'Ctrl+C is delivered as ETX to raw-mode programs, but does not interrupt cmd.exe ping as a Windows console control event',
    ],
  };
}
