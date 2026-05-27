// @vitest-environment jsdom
import { act, fireEvent, render } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TerminalView } from '../TerminalView';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
});

const baseProps: any = {
  sessionId: 's1',
  active: true,
  renderBufferSnapshot: {
    lines: [[{ char: 97, fg: 256, bg: 256, flags: 0, width: 1 }]],
    gapRanges: [],
    startIndex: 0,
    endIndex: 1,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: 1,
    daemonHeadRevision: 1,
    daemonHeadEndIndex: 1,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    revision: 1,
  },
};

describe('system copy state machine guards', () => {
  it('entry: copy mode long-press opens app row menu instead of native selection', () => {
    vi.useFakeTimers();
    const onLongPressRow = vi.fn();
    const { container } = render(<TerminalView {...baseProps} copyModeActive onLongPressRow={onLongPressRow} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    fireEvent.pointerDown(row, { clientX: 12, clientY: 16 });
    act(() => vi.advanceTimersByTime(430));
    expect(host.style.userSelect).toBe('none');
    expect(onLongPressRow).toHaveBeenCalledWith('s1', 0, 12, 16);
    vi.useRealTimers();
  });

  it('expand-selection: row is app-selectable in copy mode and blocks system selection', () => {
    const { container } = render(<TerminalView {...baseProps} copyModeActive onLongPressRow={vi.fn()} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row.style.userSelect).toBe('none');
    expect(row.getAttribute('data-terminal-copy-mode')).toBe('true');
  });

  it('scroll-expand: terminal host keeps vertical scroll enabled', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    expect(host.style.overflowY).toBe('auto');
  });

  it('highlight-selection: selected buffer rows are highlighted by absolute row index', () => {
    const { container } = render(<TerminalView {...baseProps} copyModeActive copyStartRowIndex={0} copyEndRowIndex={0} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row.style.backgroundColor).toBe('rgba(83, 139, 255, 0.18)');
  });

  it('retry-after-failure: no custom copy failure toast path in TerminalView', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    expect(container.textContent || '').not.toContain('复制失败');
  });
});
