import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { TerminalBufferPayload, TerminalCell } from './types';
import { cellsToLine } from './terminal-buffer';
import { replayBufferSyncHistory } from './terminal-buffer-replay';
import { DEFAULT_TERMINAL_CACHE_LINES } from './mobile-config';

interface ProbeHistoryEntry {
  type: 'buffer-sync';
  payload: TerminalBufferPayload;
}

interface ReplayStepResult {
  label: string;
  historyLength: number;
  oracle: {
    paneRows: number;
    paneCols: number;
    lines: string[];
  };
}

function normalizeCapture(raw: string) {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .split('\n')
    .filter((_, index, arr) => !(index === arr.length - 1 && arr[index] === ''))
    .map((line) => line.replace(/\s+$/u, ''));
}

function deriveRenderRows(options: {
  lines: TerminalCell[][];
  startIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
}) {
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 24));
  const viewportBottomIndex = Math.max(0, Math.floor(options.viewportEndIndex));
  const viewportTopIndex = Math.max(0, viewportBottomIndex - viewportRows);
  const rows: string[] = [];

  for (let index = viewportTopIndex; index < viewportBottomIndex; index += 1) {
    const rowOffset = index - options.startIndex;
    rows.push(
      rowOffset >= 0 && rowOffset < options.lines.length
        ? cellsToLine(options.lines[rowOffset] || [])
        : '',
    );
  }

  return rows;
}

function loadReplayCase(caseName: string) {
  const caseDir = join(process.cwd(), 'evidence', 'daemon-mirror', '2026-04-27', caseName);
  const history = JSON.parse(readFileSync(join(caseDir, 'probe-history.json'), 'utf8')) as ProbeHistoryEntry[];
  const tmuxCapture = normalizeCapture(readFileSync(join(caseDir, 'tmux-capture.txt'), 'utf8'));
  const metricsText = readFileSync(join(caseDir, 'tmux-metrics.txt'), 'utf8');
  const stepResults = JSON.parse(readFileSync(join(caseDir, 'step-results.json'), 'utf8')) as ReplayStepResult[];
  const rowsMatch = metricsText.match(/^rows=(\d+)$/m);
  const colsMatch = metricsText.match(/^cols=(\d+)$/m);

  return {
    history,
    tmuxCapture,
    paneRows: rowsMatch ? Number.parseInt(rowsMatch[1], 10) : 24,
    paneCols: colsMatch ? Number.parseInt(colsMatch[1], 10) : 80,
    stepResults,
  };
}

function replayHistory(
  history: ProbeHistoryEntry[],
  paneRows: number,
  paneCols: number,
) {
  const buffer = replayBufferSyncHistory({
    history,
    rows: paneRows,
    cols: paneCols,
    cacheLines: DEFAULT_TERMINAL_CACHE_LINES,
  });

  return deriveRenderRows({
    lines: buffer.lines,
    startIndex: buffer.startIndex,
    viewportEndIndex: buffer.bufferTailEndIndex,
    viewportRows: paneRows,
  });
}

describe('terminal buffer replay evidence gate', () => {
  const replayCases = [
    'codex-live',
    'daemon-restart-recover',
    'external-input-echo',
    'initial-sync',
    'local-input-echo',
    'schedule-fire',
    'top-live',
    'vim-live',
  ] as const;

  it.each(replayCases)('replays %s probe history to the same visible rows as tmux oracle', (caseName) => {
    const replayCase = loadReplayCase(caseName);
    const actual = replayHistory(replayCase.history, replayCase.paneRows, replayCase.paneCols);
    expect(actual).toEqual(replayCase.tmuxCapture);

    for (const step of replayCase.stepResults) {
      const stepActual = replayHistory(
        replayCase.history.slice(0, step.historyLength),
        step.oracle.paneRows || replayCase.paneRows,
        step.oracle.paneCols || replayCase.paneCols,
      );
      expect(stepActual).toEqual(step.oracle.lines);
    }
  });
});
