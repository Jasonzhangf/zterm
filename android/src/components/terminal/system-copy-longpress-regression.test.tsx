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

describe('system copy long-press regression', () => {
  it('RED: terminal row should allow native long-press menu by not forcing touch-action pan-x pan-y', () => {
    const { container } = render(<TerminalView {...baseProps} />);
    const host = container.querySelector('.wterm') as HTMLDivElement;
    // 当前实现是 pan-x pan-y，会拦截/竞争长按系统菜单，本用例先红
    expect(host.style.touchAction).not.toBe('pan-x pan-y');
  });
});
