import type { SessionBufferState, TerminalBufferPayload } from './types';
import { applyBufferSyncToSessionBuffer, createSessionBufferState } from './terminal-buffer';

export function replayBufferSyncHistory(options: {
  history: Array<{ type: string; payload: TerminalBufferPayload }>;
  rows: number;
  cols: number;
  cacheLines: number;
}): SessionBufferState {
  let buffer = createSessionBufferState({
    cacheLines: options.cacheLines,
    lines: [],
    rows: options.rows,
    cols: options.cols,
  });

  for (const item of options.history) {
    if (item.type !== 'buffer-sync') {
      continue;
    }
    const nextRevision = Math.max(0, Math.floor(item.payload.revision || 0));
    if (nextRevision < Math.max(0, Math.floor(buffer.revision || 0))) {
      buffer = createSessionBufferState({
        cacheLines: options.cacheLines,
        lines: [],
        rows: item.payload.rows || buffer.rows || options.rows,
        cols: item.payload.cols || buffer.cols || options.cols,
        cursorKeysApp: item.payload.cursorKeysApp,
        cursor: item.payload.cursor,
        revision: 0,
      });
    }
    buffer = applyBufferSyncToSessionBuffer(buffer, item.payload, options.cacheLines);
  }

  return buffer;
}
