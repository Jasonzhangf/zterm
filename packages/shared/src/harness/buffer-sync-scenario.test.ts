/**
 * buffer-sync-scenario.test.ts — Local harness scenario: input → head → sync → render chain.
 *
 * Tests the buffer sync decision pipeline using only shared pure functions.
 * No Android/React/page dependency.
 */
import { describe, it, expect } from 'vitest';
import { resolveTailRefreshWindow } from '../terminal/buffer-sync-request-planner';
import { shouldPullFollowBuffer, shouldCatchUpFollowTailAfterBufferApply } from '../terminal/buffer-sync-planner';
import { resolveTerminalRequestWindowLines } from '../terminal/viewport-utils';
import { resolveHeadAvailableBounds, hasLocalWindow } from '../terminal/buffer-head-state';
import { collectIntersectingGapRanges } from '../terminal/gap-utils';
import type { TerminalGapRange } from '../connection/types';

interface BufferSnapshot {
  startIndex: number;
  endIndex: number;
  bufferTailEndIndex: number;
  revision: number;
  rows: number;
  cols: number;
  gapRanges: TerminalGapRange[];
}

function emptyBuffer(rows = 40, cols = 80): BufferSnapshot {
  return { startIndex: 0, endIndex: 0, bufferTailEndIndex: 0, revision: 0, rows, cols, gapRanges: [] };
}

describe('buffer-sync-scenario: input → head → sync → render chain', () => {
  it('Scenario 1: cold-start — empty buffer, daemon head arrives, full pull', () => {
    const buf = emptyBuffer();
    const head = { sessionId: 's1', revision: 5, latestEndIndex: 100, availableStartIndex: 0, availableEndIndex: 100, cursorKeysApp: false };
    const viewportRows = buf.rows;
    const desiredEnd = head.latestEndIndex;
    const cacheLines = resolveTerminalRequestWindowLines(viewportRows);

    // No local window → should pull
    const localHW = hasLocalWindow(buf.startIndex, buf.endIndex, buf.revision);
    expect(localHW).toBe(false);

    const pull = shouldPullFollowBuffer({
      localHasWindow: localHW,
      distanceToHead: Math.max(0, desiredEnd - buf.endIndex),
      cacheLines,
      localEndIndex: buf.endIndex,
      desiredEndIndex: desiredEnd,
      daemonRevision: head.revision,
      localRevision: buf.revision,
    });
    expect(pull).toBe(true);

    // Build sync request window
    const bounds = resolveHeadAvailableBounds(head, buf);
    const window = resolveTailRefreshWindow({
      authoritativeHeadStartIndex: bounds.availableStartIndex ?? 0,
      viewportEndIndex: desiredEnd,
      viewportRows,
      cacheLines,
      localHasWindow: localHW,
      distanceToHead: Math.max(0, desiredEnd - buf.endIndex),
      sameEndRevisionAdvanced: false,
      sameEndWindowHasLocalGaps: false,
      invalidLocalWindow: false,
      requestWindowOverride: null,
    });
    expect(window.requestStartIndex).toBe(0);
    expect(window.requestEndIndex).toBe(100);
  });

  it('Scenario 2: incremental tail-refresh when daemon grows', () => {
    const buf: BufferSnapshot = {
      startIndex: 0, endIndex: 100, bufferTailEndIndex: 100, revision: 5, rows: 40, cols: 80, gapRanges: [],
    };
    const head = { sessionId: 's1', revision: 10, latestEndIndex: 200, availableStartIndex: 0, availableEndIndex: 200, cursorKeysApp: false };
    const viewportRows = buf.rows;
    const desiredEnd = head.latestEndIndex;
    const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
    const dist = Math.max(0, desiredEnd - buf.endIndex);
    const localHW = hasLocalWindow(buf.startIndex, buf.endIndex, buf.revision);

    const pull = shouldPullFollowBuffer({
      localHasWindow: localHW, distanceToHead: dist, cacheLines,
      localEndIndex: buf.endIndex, desiredEndIndex: desiredEnd,
      daemonRevision: head.revision, localRevision: buf.revision,
    });
    expect(pull).toBe(true);

    const bounds = resolveHeadAvailableBounds(head, buf);
    const window = resolveTailRefreshWindow({
      authoritativeHeadStartIndex: bounds.availableStartIndex ?? 0,
      viewportEndIndex: desiredEnd, viewportRows, cacheLines,
      localHasWindow: localHW, distanceToHead: dist,
      sameEndRevisionAdvanced: false, sameEndWindowHasLocalGaps: false,
      invalidLocalWindow: false, requestWindowOverride: null,
    });
    // Branch 3: incremental from local end 100
    expect(window.requestStartIndex).toBe(100);
    expect(window.requestEndIndex).toBe(200);
  });

  it('Scenario 3: same-end revision advanced → full window refresh', () => {
    const buf: BufferSnapshot = {
      startIndex: 0, endIndex: 200, bufferTailEndIndex: 200, revision: 5, rows: 40, cols: 80, gapRanges: [],
    };
    const head = { sessionId: 's1', revision: 10, latestEndIndex: 200, availableStartIndex: 0, availableEndIndex: 200, cursorKeysApp: false };
    const viewportRows = buf.rows;
    const desiredEnd = head.latestEndIndex;
    const cacheLines = resolveTerminalRequestWindowLines(viewportRows);
    const localHW = hasLocalWindow(buf.startIndex, buf.endIndex, buf.revision);
    const dist = Math.max(0, desiredEnd - buf.endIndex);

    // sameEndRevisionAdvanced: localHW && dist===0 && daemon>local
    const sameEnd = localHW && dist === 0 && head.revision > buf.revision;
    expect(sameEnd).toBe(true);

    const bounds = resolveHeadAvailableBounds(head, buf);
    const window = resolveTailRefreshWindow({
      authoritativeHeadStartIndex: bounds.availableStartIndex ?? 0,
      viewportEndIndex: desiredEnd, viewportRows, cacheLines,
      localHasWindow: localHW, distanceToHead: dist,
      sameEndRevisionAdvanced: sameEnd, sameEndWindowHasLocalGaps: false,
      invalidLocalWindow: false, requestWindowOverride: null,
    });
    // Branch 5: same-end revision, no gaps → visible-window refresh only
    // (planner truth changed from full-cache to visible window: buffer patches
    // repaint by row/range, never whole-screen — see buffer-sync-request-planner.test.ts Branch 5)
    expect(window.requestEndIndex).toBe(200);
    expect(window.requestStartIndex).toBe(Math.max(0, 200 - viewportRows));
  });

  it('Scenario 4: reading-repair with gaps in visible range', () => {
    const gapRanges: TerminalGapRange[] = [{ startIndex: 50, endIndex: 60 }];
    const visibleStart = 40;
    const visibleEnd = 80;

    const missing = collectIntersectingGapRanges(gapRanges, visibleStart, visibleEnd);
    expect(missing).toEqual([{ startIndex: 50, endIndex: 60 }]);

    // Using requestWindowOverride for targeted reading-repair
    const window = resolveTailRefreshWindow({
      authoritativeHeadStartIndex: 0,
      viewportEndIndex: visibleEnd,
      viewportRows: 40,
      cacheLines: 120,
      localHasWindow: true,
      distanceToHead: 0,
      sameEndRevisionAdvanced: false,
      sameEndWindowHasLocalGaps: false,
      invalidLocalWindow: false,
      requestWindowOverride: { requestStartIndex: visibleStart, requestEndIndex: visibleEnd },
    });
    expect(window.requestStartIndex).toBe(40);
    expect(window.requestEndIndex).toBe(80);
  });

  it('Scenario 5: catch-up follow tail after buffer apply', () => {
    // After applying a buffer that brought us to end=100, but daemon is now at 200
    const catchUp = shouldCatchUpFollowTailAfterBufferApply({
      localHasWindow: true,
      distanceToHead: 100, // daemon is 100 rows ahead
      cacheLines: 120,
      localEndIndex: 100,
      desiredEndIndex: 200,
      daemonRevision: 10,
      localRevision: 5,
      forceSameEndRefresh: false,
    });
    expect(catchUp).toBe(true);
  });

  it('Scenario 6: no pull needed when buffer is up-to-date', () => {
    const pull = shouldPullFollowBuffer({
      localHasWindow: true,
      distanceToHead: 0,
      cacheLines: 120,
      localEndIndex: 200,
      desiredEndIndex: 200,
      daemonRevision: 10,
      localRevision: 10,
    });
    expect(pull).toBe(false);
  });
});
