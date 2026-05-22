// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
import { TerminalView } from './TerminalView';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as any).ResizeObserver = ResizeObserverMock;
});

describe('TerminalView system selection mode', () => {
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

  it('keeps terminal rows selectable for system copy', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.userSelect).toBe('text');
  });

  it('does not register custom copy mode pointer handlers', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    expect(host.getAttribute('onpointerdown')).toBeNull();
  });
});
