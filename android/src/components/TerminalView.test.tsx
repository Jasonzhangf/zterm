// @vitest-environment jsdom

import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';
import type { SessionRenderBufferSnapshot } from '../lib/types';

class ResizeObserverMock {
  static instances = new Set<ResizeObserverMock>();

  private readonly callback: ResizeObserverCallback;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ResizeObserverMock.instances.add(this);
  }

  observe() {}
  unobserve() {}
  disconnect() {
    ResizeObserverMock.instances.delete(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }

  static triggerAll() {
    for (const instance of Array.from(ResizeObserverMock.instances)) {
      instance.trigger();
    }
  }

  static reset() {
    ResizeObserverMock.instances.clear();
  }
}

function buildRenderBufferSnapshot(): SessionRenderBufferSnapshot {
  return {
    lines: [[{ char: 65, fg: 256, bg: 256, flags: 0, width: 1 }]],
    gapRanges: [],
    startIndex: 0,
    endIndex: 1,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: 1,
    daemonHeadRevision: 1,
    daemonHeadEndIndex: 24,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    revision: 1,
  };
}

describe('TerminalView RAF throttle', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    vi.useFakeTimers();
    ResizeObserverMock.reset();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 640;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 408;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.textContent === 'W') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 6,
          bottom: 17,
          width: 6,
          height: 17,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 408,
        width: 640,
        height: 408,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    ResizeObserverMock.reset();
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.ResizeObserver;
    }
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
  });

  it('limits split-visible resize bursts to one RAF after the 32ms gate', async () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1 as any);

    render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          splitVisible
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    requestAnimationFrameSpy.mockClear();

    ResizeObserverMock.triggerAll();
    ResizeObserverMock.triggerAll();
    ResizeObserverMock.triggerAll();
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(31);
    });
    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(1);
    });
    expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);

    requestAnimationFrameSpy.mockRestore();
  });

  it('lets copy-mode row touchstart bubble so the session drawer right-swipe surface still sees it', () => {
    const onParentTouchStart = vi.fn();
    const onLongPressRow = vi.fn();
    const { container } = render(
      <div
        style={{ width: '640px', height: '408px' }}
        onTouchStart={onParentTouchStart}
      >
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          copyModeActive
          onLongPressRow={onLongPressRow}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const row = container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    expect(row).toBeTruthy();

    fireEvent.touchStart(row, {
      touches: [{ clientX: 40, clientY: 80 }],
      changedTouches: [{ clientX: 40, clientY: 80 }],
    });

    expect(onParentTouchStart).toHaveBeenCalledTimes(1);
    expect(onLongPressRow).not.toHaveBeenCalled();
  });

  it('hides the inner terminal scrollbar while keeping vertical scrolling enabled', () => {
    const { container } = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLDivElement;
    expect(host).toBeTruthy();
    expect(host.style.overflowY).toBe('auto');
    expect(host.style.scrollbarWidth).toBe('none');
    expect(container.textContent).toContain('.wterm::-webkit-scrollbar');
  });

  it('keeps preview projection read-only and removes the hidden input surface', () => {
    const { container } = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          live={false}
          projectionMode="preview-secondary"
          fontSize={3}
          rowHeight="4px"
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLDivElement;
    expect(host.dataset.projectionMode).toBe('preview-secondary');
    expect(host.style.webkitTextSizeAdjust).toBe('none');
    expect(container.querySelector('[data-wterm-input="true"]')).toBeNull();
    expect(container.querySelectorAll('[data-terminal-preview-row="true"]')).toHaveLength(1);
    expect(container.querySelector('[data-terminal-cursor="true"]')).toBeNull();
  });

  it('does not schedule interactive geometry frames for a passive preview buffer update', () => {
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1 as any);
    const initialSnapshot = buildRenderBufferSnapshot();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={initialSnapshot}
          live={false}
          projectionMode="preview-secondary"
          fontSize={3}
          rowHeight="4px"
        />
      </div>,
    );

    requestAnimationFrameSpy.mockClear();
    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{ ...initialSnapshot, revision: 2 }}
          live={false}
          projectionMode="preview-secondary"
          fontSize={3}
          rowHeight="4px"
        />
      </div>,
    );

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();
    requestAnimationFrameSpy.mockRestore();
  });

  it('keeps a passive preview tail visible when its buffer grows', () => {
    const initialSnapshot = buildRenderBufferSnapshot();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={initialSnapshot}
          live={false}
          projectionMode="preview-secondary"
          fontSize={3}
          rowHeight="4px"
        />
      </div>,
    );

    expect(view.container.querySelectorAll('[data-terminal-preview-row="true"]')).toHaveLength(1);

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            ...initialSnapshot,
            lines: [
              ...initialSnapshot.lines,
              [{ char: 66, fg: 256, bg: 256, flags: 0, width: 1 }],
            ],
            endIndex: 2,
            bufferTailEndIndex: 2,
            revision: 2,
          }}
          live={false}
          projectionMode="preview-secondary"
          fontSize={3}
          rowHeight="4px"
        />
      </div>,
    );

    expect(view.container.querySelectorAll('[data-terminal-preview-row="true"]')).toHaveLength(2);
    expect(view.container.textContent).toContain('B');
  });
});
