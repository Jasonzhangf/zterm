import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import {
  applyBufferSyncToSessionBuffer,
  cellsToLine,
  createSessionBufferState,
} from '../src/lib/terminal-buffer';
import type { TerminalBufferPayload, TerminalCell } from '../src/lib/types';

interface ProbeHistoryEntry {
  at: string;
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

function deriveRenderRows(options: {
  lines: TerminalCell[][];
  startIndex: number;
  viewportEndIndex: number;
  viewportRows: number;
}) {
  const viewportRows = Math.max(1, Math.floor(options.viewportRows || 24));
  const viewportBottomIndex = Math.max(0, Math.floor(options.viewportEndIndex));
  const viewportTopIndex = Math.max(0, viewportBottomIndex - viewportRows);
  const rows: Array<{ index: number; row: TerminalCell[] }> = [];

  for (let index = viewportTopIndex; index < viewportBottomIndex; index += 1) {
    const rowOffset = index - options.startIndex;
    rows.push({
      index,
      row:
        rowOffset >= 0 && rowOffset < options.lines.length
          ? options.lines[rowOffset] || []
          : [],
    });
  }

  return {
    viewportTopIndex,
    viewportBottomIndex,
    rows,
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

function readCaseFiles(caseDir: string) {
  const probeHistoryPath = join(caseDir, 'probe-history.json');
  const tmuxCapturePath = join(caseDir, 'tmux-capture.txt');
  const tmuxMetricsPath = join(caseDir, 'tmux-metrics.txt');
  const stepResultsPath = join(caseDir, 'step-results.json');

  const history = JSON.parse(readFileSync(probeHistoryPath, 'utf8')) as ProbeHistoryEntry[];
  const tmuxCapture = normalizeCapture(readFileSync(tmuxCapturePath, 'utf8'));
  const metricsText = readFileSync(tmuxMetricsPath, 'utf8');
  const rowsMatch = metricsText.match(/^rows=(\d+)$/m);
  const colsMatch = metricsText.match(/^cols=(\d+)$/m);
  const paneRows = rowsMatch ? Number.parseInt(rowsMatch[1], 10) : 24;
  const paneCols = colsMatch ? Number.parseInt(colsMatch[1], 10) : 80;
  let stepResults: ReplayStepResult[] = [];
  try {
    stepResults = JSON.parse(readFileSync(stepResultsPath, 'utf8')) as ReplayStepResult[];
  } catch {}

  return {
    history,
    tmuxCapture,
    paneRows,
    paneCols,
    stepResults,
  };
}

function replayBuffer(
  history: ProbeHistoryEntry[],
  paneRows: number,
  paneCols: number,
) {
  let buffer = createSessionBufferState({
    cacheLines: 3000,
    lines: [],
    rows: paneRows,
    cols: paneCols,
  });

  for (const item of history) {
    buffer = applyBufferSyncToSessionBuffer(buffer, item.payload, 3000);
  }

  const renderWindow = deriveRenderRows({
    lines: buffer.lines,
    startIndex: buffer.startIndex,
    viewportEndIndex: buffer.bufferTailEndIndex,
    viewportRows: paneRows,
  });

  return {
    renderWindow,
    actual: renderWindow.rows.map((entry) => cellsToLine(entry.row)),
  };
}

function replay(caseDir: string) {
  const { history, tmuxCapture, paneRows, paneCols, stepResults } = readCaseFiles(caseDir);
  const { renderWindow, actual } = replayBuffer(history, paneRows, paneCols);
  let mismatchIndex: number | null = null;
  const compareLength = Math.max(tmuxCapture.length, actual.length);
  for (let index = 0; index < compareLength; index += 1) {
    if ((tmuxCapture[index] || '') !== (actual[index] || '')) {
      mismatchIndex = index;
      break;
    }
  }

  const stepChecks = stepResults.map((step) => {
    const stepRows = step.oracle?.paneRows || paneRows;
    const stepCols = step.oracle?.paneCols || paneCols;
    const stepExpected = step.oracle?.lines || [];
    const { actual: stepActual } = replayBuffer(history.slice(0, step.historyLength), stepRows, stepCols);
    let stepMismatchIndex: number | null = null;
    const stepCompareLength = Math.max(stepExpected.length, stepActual.length);
    for (let index = 0; index < stepCompareLength; index += 1) {
      if ((stepExpected[index] || '') !== (stepActual[index] || '')) {
        stepMismatchIndex = index;
        break;
      }
    }
    return {
      label: step.label,
      ok: stepMismatchIndex === null,
      mismatchIndex: stepMismatchIndex,
      historyLength: step.historyLength,
      expected: stepExpected,
      actual: stepActual,
    };
  });

  const result = {
    ok: mismatchIndex === null && stepChecks.every((step) => step.ok),
    mismatchIndex,
    paneRows,
    paneCols,
    viewportTopIndex: renderWindow.viewportTopIndex,
    viewportBottomIndex: renderWindow.viewportBottomIndex,
    expected: tmuxCapture,
    actual,
    stepChecks,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (mismatchIndex !== null) {
    process.exitCode = 1;
  }
}

const arg = process.argv[2];
if (!arg) {
  throw new Error('usage: pnpm exec tsx scripts/client-mirror-replay.ts <case-dir>');
}

replay(resolve(process.cwd(), arg));
