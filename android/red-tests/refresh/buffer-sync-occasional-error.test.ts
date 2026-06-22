import { describe, expect, it } from 'vitest';
import {
  applyBufferSyncToSessionBuffer,
  createSessionBufferState,
  type TerminalBufferPayload,
} from '../../../packages/shared/src/connection/terminal-buffer';

function payload(input: {
  startIndex: number;
  endIndex: number;
  availableStartIndex?: number;
  availableEndIndex?: number;
  revision: number;
  rows?: number;
  lines: Array<[number, string]>;
  cursorKeysApp?: boolean;
}): TerminalBufferPayload {
  return {
    revision: input.revision,
    startIndex: input.startIndex,
    endIndex: input.endIndex,
    availableStartIndex: input.availableStartIndex,
    availableEndIndex: input.availableEndIndex,
    cols: 80,
    rows: input.rows ?? 24,
    cursorKeysApp: input.cursorKeysApp ?? false,
    lines: input.lines.map(([index, text]) => ({
      index,
      cells: Array.from(text).map((char) => ({
        char: char.codePointAt(0) || 32,
        fg: 256,
        bg: 256,
        flags: 0,
        width: 1,
      })),
    })),
  };
}

function lineText(cells: Array<{ char: number }>): string {
  return cells.map((c) => String.fromCodePoint(c.char)).join('');
}

describe('refresh occasional error audit', () => {
  // Case 1: same-revision patch inside current window must not lose payload lines.
  // This is the "tail disappears after a few refreshes" symptom reported on device.
  it('preserves same-revision patch lines when payload window is fully inside current window', () => {
    const initial = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 100,
        endIndex: 108,
        availableStartIndex: 100,
        availableEndIndex: 108,
        revision: 1,
        lines: Array.from({ length: 8 }, (_, i) => [100 + i, `init-${100 + i}`]),
      }),
      200,
    );

    const next = applyBufferSyncToSessionBuffer(
      initial,
      payload({
        startIndex: 103,
        endIndex: 105,
        availableStartIndex: 100,
        availableEndIndex: 108,
        revision: 1, // SAME revision
        lines: [
          [103, 'patched-103'],
          [104, 'patched-104'],
        ],
      }),
      200,
    );

    // The two patched lines MUST appear at the right absolute positions.
    // (current: same-revision patches with payload inside current window are silently ignored)
    const offset103 = 103 - next.startIndex;
    const offset104 = 104 - next.startIndex;
    expect(next.startIndex).toBe(100);
    expect(next.endIndex).toBe(108);
    expect(lineText(next.lines[offset103])).toBe('patched-103');
    expect(lineText(next.lines[offset104])).toBe('patched-104');
    // The unmodified lines should still be intact.
    expect(lineText(next.lines[0])).toBe('init-100');
    expect(lineText(next.lines[5])).toBe('init-105');
  });

  // Case 2: empty current buffer must not lose payload lines.
  // (current: when current.lines.length === 0, the patcher skips the entire copy loop
  //  and only writes sparseWindow lines; this is fine. But when the same code path is
  //  hit on subsequent sync with sparseWindow.startIndex > nextStartIndex, we can lose.)
  it('does not lose lines when sparse window partially overlaps a freshly-built buffer', () => {
    const initial = createSessionBufferState({
      cacheLines: 200,
      lines: Array.from({ length: 8 }, (_, i) => `init-${100 + i}`),
      startIndex: 100,
      endIndex: 108,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 108,
      cols: 80,
      rows: 24,
      revision: 1,
    });

    // Tail-only patch with revision+1.
    const next = applyBufferSyncToSessionBuffer(
      initial,
      payload({
        startIndex: 105,
        endIndex: 110,
        availableStartIndex: 100,
        availableEndIndex: 110,
        revision: 2,
        lines: Array.from({ length: 5 }, (_, i) => [105 + i, `next-${105 + i}`]),
      }),
      200,
    );

    expect(next.startIndex).toBe(100);
    expect(next.endIndex).toBe(110);
    // Lines 100..104 MUST survive the tail-append.
    expect(lineText(next.lines[0])).toBe('init-100');
    expect(lineText(next.lines[4])).toBe('init-104');
    // Lines 105..109 should be the new tail.
    expect(lineText(next.lines[5])).toBe('next-105');
    expect(lineText(next.lines[9])).toBe('next-109');
  });

  // Case 3: head-trim must not leave stale gap ranges or duplicate rows in
  // a window the daemon reasserted after a follow catch-up.
  it('keeps gap-free window after follow catch-up that retracts bufferHeadStartIndex', () => {
    const initial = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 90,
        endIndex: 110,
        availableStartIndex: 90,
        availableEndIndex: 110,
        revision: 1,
        lines: Array.from({ length: 20 }, (_, i) => [90 + i, `init-${90 + i}`]),
      }),
      200,
    );

    // Tail-only patch; no payload lines for the head but the head stays the same.
    const next = applyBufferSyncToSessionBuffer(
      initial,
      payload({
        startIndex: 105,
        endIndex: 112,
        availableStartIndex: 90,
        availableEndIndex: 112,
        revision: 2,
        lines: Array.from({ length: 7 }, (_, i) => [105 + i, `next-${105 + i}`]),
      }),
      200,
    );

    expect(next.startIndex).toBe(90);
    expect(next.endIndex).toBe(112);
    expect(next.bufferHeadStartIndex).toBe(90);
    expect(next.bufferTailEndIndex).toBe(112);
    // No gap ranges should remain because all 22 lines are present.
    expect(next.gapRanges).toEqual([]);
  });

  // Case 4: revision-equal patch with cursor-only change must not move lines.
  it('does not move startIndex when only cursor changes (same revision, no new lines)', () => {
    const initial = applyBufferSyncToSessionBuffer(
      undefined,
      payload({
        startIndex: 100,
        endIndex: 105,
        availableStartIndex: 100,
        availableEndIndex: 105,
        revision: 1,
        lines: Array.from({ length: 5 }, (_, i) => [100 + i, `init-${100 + i}`]),
      }),
      200,
    );

    const next = applyBufferSyncToSessionBuffer(
      initial,
      payload({
        startIndex: 100,
        endIndex: 105,
        availableStartIndex: 100,
        availableEndIndex: 105,
        revision: 1,
        lines: [],
      }),
      200,
    );

    expect(next.startIndex).toBe(100);
    expect(next.endIndex).toBe(105);
    expect(lineText(next.lines[0])).toBe('init-100');
  });
});
