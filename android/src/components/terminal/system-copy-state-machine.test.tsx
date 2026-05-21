// @vitest-environment jsdom
import { render } from '@testing-library/react';
import { beforeAll, describe, expect, it } from 'vitest';
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
  it('entry: long-press relies on native selection menu (no custom pointer handler)', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    expect(host.getAttribute('onpointerdown')).toBeNull();
  });

  it('expand-selection: row remains text-selectable', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row.style.userSelect).toBe('text');
  });

  it('scroll-expand: terminal host keeps vertical scroll enabled', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    expect(host.style.overflowY).toBe('auto');
  });

  it('confirm-copy: no app-layer confirm modal path exists on TerminalView', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    expect(container.textContent || '').not.toContain('是否拷贝到剪贴板');
  });

  it('cancel-selection: no app-layer copy selection state is rendered', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    expect(container.innerHTML).not.toContain('COPY:ON');
  });

  it('retry-after-failure: no custom copy failure toast path in TerminalView', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    expect(container.textContent || '').not.toContain('复制失败');
  });
});
