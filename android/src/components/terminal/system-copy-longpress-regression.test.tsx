// @vitest-environment jsdom
import { render } from '@testing-library/react';
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

describe('system copy long-press regression', () => {
  it('copy mode disables native callout so app long-press menu owns selection', () => {
    const { container } = render(<TerminalView {...baseProps} copyModeActive onLongPressRow={vi.fn()} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(host.getAttribute('data-copy-mode')).toBe('true');
    expect(row.getAttribute('data-terminal-copy-mode')).toBe('true');
    expect(container.querySelector('style')?.textContent || '').toContain('-webkit-touch-callout:none');
  });

  it('copy mode installs native non-passive capture guards for Android WebView long press', () => {
    const addSpy = vi.spyOn(HTMLElement.prototype, 'addEventListener');
    const { unmount } = render(<TerminalView {...baseProps} copyModeActive onLongPressRow={vi.fn()} />);

    expect(addSpy).toHaveBeenCalledWith(
      'touchstart',
      expect.any(Function),
      expect.objectContaining({ capture: true, passive: false }),
    );
    expect(addSpy).toHaveBeenCalledWith(
      'contextmenu',
      expect.any(Function),
      expect.objectContaining({ capture: true, passive: false }),
    );
    expect(addSpy).toHaveBeenCalledWith(
      'selectstart',
      expect.any(Function),
      expect.objectContaining({ capture: true, passive: false }),
    );

    unmount();
    addSpy.mockRestore();
  });
});
