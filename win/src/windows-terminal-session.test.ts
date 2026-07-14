import { describe, expect, it } from 'vitest';
import { applyBufferSyncToSessionBuffer, createSessionBufferState } from '@zterm/shared';
import { canRequestWindowsVisibleRange, projectWindowsTerminalBuffer, type WindowsTerminalSnapshot } from './windows-terminal-session';

describe('windows terminal session shared buffer binding', () => {
  it('projects shared sparse-buffer truth without copying renderer semantics', () => {
    const initial = createSessionBufferState({ lines: [], cols: 80, rows: 24, cacheLines: 3000 });
    const next = applyBufferSyncToSessionBuffer(initial, {
      revision: 1,
      startIndex: 0,
      endIndex: 1,
      availableStartIndex: 0,
      availableEndIndex: 1,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      lines: [{ i: 0, t: 'WINDOWS_SHARED_BUFFER_OK' }],
    }, 3000);

    const projection = projectWindowsTerminalBuffer(next);
    expect(projection.revision).toBe(1);
    expect(String.fromCodePoint(...projection.lines[0]!.filter((cell) => cell.width !== 0).map((cell) => cell.char))).toContain('WINDOWS_SHARED_BUFFER_OK');
    expect(projection.startIndex).toBe(0);
    expect(projection.endIndex).toBe(1);
  });
});

describe('windows terminal visible range request gate', () => {
  it('waits for the first mirror buffer before requesting a visible range', () => {
    const emptyBuffer = createSessionBufferState({ lines: [], cols: 80, rows: 24, cacheLines: 3000 });
    const connecting: WindowsTerminalSnapshot = { status: 'connecting', error: '', sessionId: '', buffer: emptyBuffer };
    const connectedBeforeMirror: WindowsTerminalSnapshot = { status: 'connected', error: '', sessionId: 's1', buffer: emptyBuffer };
    const connectedAfterMirror: WindowsTerminalSnapshot = {
      status: 'connected',
      error: '',
      sessionId: 's1',
      buffer: { ...emptyBuffer, revision: 1 },
    };

    expect(canRequestWindowsVisibleRange(connecting)).toBe(false);
    expect(canRequestWindowsVisibleRange(connectedBeforeMirror)).toBe(false);
    expect(canRequestWindowsVisibleRange(connectedAfterMirror)).toBe(true);
  });
});
