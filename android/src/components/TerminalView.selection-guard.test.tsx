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

describe('TerminalView selection guard', () => {
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
    onTapRow: vi.fn(),
    onLongPressRow: vi.fn(),
  } as any;

  it('normal mode keeps terminal rows selectable for system copy', () => {
    const { container } = render(<TerminalView {...baseProps} copyModeActive={false} />);
    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.style.userSelect).toBe('text');
  });

  it('copy-mode pointer handlers do not run in normal mode', () => {
    const onTapRow = vi.fn();
    const onLongPressRow = vi.fn();
    const { container } = render(
      <TerminalView {...baseProps} copyModeActive={false} onTapRow={onTapRow} onLongPressRow={onLongPressRow} />,
    );
    const host = container.querySelector('.wterm') as HTMLDivElement;
    host.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientY: 20 }));
    host.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, clientY: 20 }));
    expect(onTapRow).not.toHaveBeenCalled();
    expect(onLongPressRow).not.toHaveBeenCalled();
  });
});
