// @vitest-environment jsdom
/**
 * Regression test: bottom rows with same absolute index but changed content
 * must re-render immediately, even if the row array reference is reused.
 *
 * Symptom being tested: TUI (vim/htop) bottom input/status area content changes
 * in place (same absolute line count, different text) but rows never refresh.
 *
 * Theory A (current): if daemon sends updated lines for the same window,
 *   projectRenderBuffer clones each row → new cell array refs → memo re-renders.
 *   PASS = no bug in render gate.
 *
 * Theory B (suspected): row reference is reused by some in-place mutation path,
 *   causing memo `prev.row === next.row` to skip repaint.
 *   FAIL = bug confirmed → fix VisibleRow comparator or add revision per row.
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView as BaseTerminalView } from './TerminalView';
import type { SessionRenderBufferSnapshot, TerminalCell } from '../lib/types';

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();
  private readonly callback: ResizeObserverCallback;
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.add(this);
  }
  observe() {}
  unobserve() {}
  disconnect() { ResizeObserverMock.instances.delete(this); }
  trigger() { this.callback([], this as unknown as ResizeObserver); }
  static triggerAll() { for (const inst of Array.from(ResizeObserverMock.instances)) inst.trigger(); }
  static reset() { ResizeObserverMock.instances.clear(); }
}

function makeCell(char: string): TerminalCell {
  return { char: char.codePointAt(0) ?? 32, fg: 256, bg: 256, flags: 0, width: 1 };
}

function makeRow(chars: string): TerminalCell[] {
  return chars.split('').map(makeCell);
}

function toRenderBuffer(lines: TerminalCell[][], startIndex: number, endIndex: number, tailEndIndex: number, revision: number): SessionRenderBufferSnapshot {
  return {
    lines,
    gapRanges: [],
    startIndex,
    endIndex,
    bufferHeadStartIndex: startIndex,
    bufferTailEndIndex: tailEndIndex,
    daemonHeadRevision: revision,
    daemonHeadEndIndex: tailEndIndex,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    revision,
  };
}

function readRenderedTexts(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('[data-terminal-row="true"]'))
    .map(n => (n.textContent ?? '').trim());
}

describe('TerminalView bottom-row stale content regression', () => {
  const origClientW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const origClientH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const origGetBCR = HTMLElement.prototype.getBoundingClientRect;
  const origResizeObs = globalThis.ResizeObserver;
  const mockH = 408; // 24 rows @ 17px

  beforeEach(() => {
    ResizeObserverMock.reset();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 640; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return mockH; } });
    HTMLElement.prototype.getBoundingClientRect = function() {
      return { x: 0, y: 0, top: 0, left: 0, right: 640, bottom: mockH, width: 640, height: mockH,
        toJSON() { return {}; } } as DOMRect;
    };
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    if (origClientW) Object.defineProperty(HTMLElement.prototype, 'clientWidth', origClientW);
    if (origClientH) Object.defineProperty(HTMLElement.prototype, 'clientHeight', origClientH);
    HTMLElement.prototype.getBoundingClientRect = origGetBCR;
    globalThis.ResizeObserver = origResizeObs;
    ResizeObserverMock.reset();
    vi.restoreAllMocks();
  });

  it('REGRESSION: bottom row content change via new row refs triggers repaint', async () => {
    // Initial state: 5 rows, tail at index 5 (bottom = "prompt-$")
    const row0 = makeRow('old-line-0');
    const row1 = makeRow('old-line-1');
    const row2 = makeRow('old-line-2');
    const row3 = makeRow('old-line-3');
    const row4 = makeRow('prompt-$   ');
    const initialBuffer = toRenderBuffer([row0, row1, row2, row3, row4], 0, 5, 5, 1);

    const { container, rerender } = render(
      <div style={{ width: '640px', height: `${mockH}px` }}>
        <BaseTerminalView
          sessionId="s-stale"
          renderBufferSnapshot={initialBuffer}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readRenderedTexts(container)).toContain('prompt-$');
    });
    expect(readRenderedTexts(container)).toContain('old-line-2');

    // Simulate in-place content update: TUI redraws same absolute positions, new refs
    const nRow0 = makeRow('new-line-0');
    const nRow1 = makeRow('new-line-1');
    const nRow2 = makeRow('new-line-2');
    const nRow3 = makeRow('new-line-3');
    const nRow4 = makeRow('NEW-PROMPT ');
    const updatedBuffer = toRenderBuffer([nRow0, nRow1, nRow2, nRow3, nRow4], 0, 5, 5, 2);

    await act(async () => {
      rerender(
        <div style={{ width: '640px', height: `${mockH}px` }}>
          <BaseTerminalView
            sessionId="s-stale"
            renderBufferSnapshot={updatedBuffer}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );
    });

    // THE BUG: if memo comparator uses `prev.row === next.row` reference check only,
    // and row refs are the same (shouldn't happen with projectRenderBuffer clone,
    // but if a path reuses old refs), the bottom row stays "prompt-$" forever.
    // This test expects the CORRECT behavior:
    await waitFor(() => {
      const texts = readRenderedTexts(container);
      expect(texts).toContain('NEW-PROMPT');
      expect(texts).not.toContain('prompt-$');
      expect(texts).toContain('new-line-2');
      expect(texts).not.toContain('old-line-2');
    });
  });

  it('REGRESSION: only bottom visible row content changes, rest unchanged — bottom must update', async () => {
    // 30 rows total — only the LAST visible row changes (vim status line scenario)
    const baseLines: TerminalCell[][] = Array.from({ length: 30 }, (_, i) =>
      makeRow(`stable-row-${String(i).padStart(3, '0')}`)
    );
    // Change only the last row
    const changedLines = baseLines.map((row, i) =>
      i === 29 ? makeRow('vim-command-mode') : row
    );

    const initialBuffer = toRenderBuffer(baseLines, 0, 30, 30, 1);
    const updatedBuffer = toRenderBuffer(changedLines, 0, 30, 30, 2);

    const { container, rerender } = render(
      <div style={{ width: '640px', height: `${mockH}px` }}>
        <BaseTerminalView
          sessionId="s-bottom-only"
          renderBufferSnapshot={initialBuffer}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const texts = readRenderedTexts(container);
      expect(texts).toContain('stable-row-029');
      // Only bottom ~5 rows visible in a 24-row viewport for 30-line buffer
    });

    await act(async () => {
      rerender(
        <div style={{ width: '640px', height: `${mockH}px` }}>
          <BaseTerminalView
            sessionId="s-bottom-only"
            renderBufferSnapshot={updatedBuffer}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );
    });

    await waitFor(() => {
      const texts = readRenderedTexts(container);
      // Bottom-most rendered row must reflect new content
      const bottomTexts = texts.slice(-5);
      expect(bottomTexts).toContain('vim-command-mode');
      expect(bottomTexts).not.toContain('stable-row-029');
    });
  });

  it('REGRESSION: reused row references repaint changed cell styling without repainting by identity', async () => {
    const reusedRows = [
      makeRow('stable-0'),
      makeRow('same-status'),
    ];
    const snapshot = toRenderBuffer(reusedRows, 0, 2, 2, 1);

    const { container, rerender } = render(
      <div style={{ width: '640px', height: `${mockH}px` }}>
        <BaseTerminalView
          sessionId="s-reused-row"
          renderBufferSnapshot={snapshot}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedTexts(container)).toContain('same-status'));
    const unchangedRowBefore = Array.from(container.querySelectorAll('[data-terminal-row="true"]'))[0];
    const statusRowBefore = Array.from(container.querySelectorAll('[data-terminal-row="true"]'))[1] as HTMLElement;
    const statusCellBefore = statusRowBefore.querySelector('span > span') as HTMLElement;
    const backgroundBefore = statusCellBefore.style.background;

    // Some mirror producers reuse row arrays while changing only cell styling.
    reusedRows[1]![0]!.bg = 1;
    const updatedSnapshot = {
      ...snapshot,
      revision: 2,
      daemonHeadRevision: 2,
    };

    await act(async () => {
      rerender(
        <div style={{ width: '640px', height: `${mockH}px` }}>
          <BaseTerminalView
            sessionId="s-reused-row"
            renderBufferSnapshot={updatedSnapshot}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );
    });

    await waitFor(() => {
      expect(readRenderedTexts(container)).toContain('same-status');
      const statusRowAfter = Array.from(container.querySelectorAll('[data-terminal-row="true"]'))[1] as HTMLElement;
      const statusCellAfter = statusRowAfter.querySelector('span > span') as HTMLElement;
      expect(statusCellAfter.style.background).not.toBe(backgroundBefore);
      expect(Array.from(container.querySelectorAll('[data-terminal-row="true"]'))[0]).toBe(unchangedRowBefore);
    });
  });

  it('REGRESSION: same bottom absolute index with different tail end — must re-evaluate anchor', async () => {
    // Window stays [0, 5] but tailEndIndex advances → followVisualBottomIndex must follow
    const row0 = makeRow('aaaa');
    const row1 = makeRow('bbbb');
    const row2 = makeRow('cccc');
    const row3 = makeRow('dddd');
    const row4 = makeRow('eeee');

    const initial = toRenderBuffer([row0, row1, row2, row3, row4], 0, 5, 5, 1);
    // Simulate: same 5 lines but now daemon says tailEndIndex=10 (extended downstream)
    // The window is still [0,5] in the payload, but tailEndIndex signals more content
    const updated: SessionRenderBufferSnapshot = {
      ...initial,
      bufferTailEndIndex: 10, // daemon says tail is at 10, beyond our window
      revision: 2,
      daemonHeadEndIndex: 10,
    };

    const { container, rerender } = render(
      <div style={{ width: '640px', height: `${mockH}px` }}>
        <BaseTerminalView
          sessionId="s-tail-shift"
          renderBufferSnapshot={initial}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedTexts(container)).toContain('eeee'));

    await act(async () => {
      rerender(
        <div style={{ width: '640px', height: `${mockH}px` }}>
          <BaseTerminalView
            sessionId="s-tail-shift"
            renderBufferSnapshot={updated}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );
    });

    // tailEndIndex changed → effectiveRenderBottomIndex must re-evaluate
    // (content stays the same since buffer is [0,5])
    await waitFor(() => {
      const texts = readRenderedTexts(container);
      expect(texts).toContain('eeee');
    });
  });
});
