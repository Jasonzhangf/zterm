// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
});

describe('TerminalView app copy selection mode', () => {
  const baseProps = {
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
  } as any;

  it('keeps normal terminal rows selectable only outside copy mode', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.userSelect).toBe('text');
  });

  it('copy mode makes terminal rows owned by app selection', () => {
    const { container } = render(<TerminalView {...baseProps} copyModeActive onLongPressRow={vi.fn()} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row.style.userSelect).toBe('none');
    expect(row.getAttribute('data-terminal-copy-mode')).toBe('true');
  });
});
