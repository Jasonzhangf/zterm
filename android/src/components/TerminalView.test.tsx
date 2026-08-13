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

describe('TerminalView mirror-fixed pinch zoom', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalResizeObserver = globalThis.ResizeObserver;

  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    ResizeObserverMock.reset();
    // 模拟窄屏：屏幕 200px < 终端逻辑宽度 80col * 3.1px = 248px -> minScale = 200/248 = 0.8065
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 200;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return 408;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0, y: 0, top: 0, left: 0, right: 200, bottom: 408,
        width: 200, height: 408,
        toJSON() { return {}; },
      } as DOMRect;
    };
  });

  afterEach(() => {
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalResizeObserver) {
      globalThis.ResizeObserver = originalResizeObserver;
    } else {
      // @ts-expect-error test cleanup
      delete globalThis.ResizeObserver;
    }
  });

  it('shrinks the term-grid via pinch in mirror-fixed mode, clamped to full-width scale', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    expect(scaleLayer).toBeTruthy();
    expect(scaleLayer.style.transform).toBe('none'); // 初始不缩放

    const host = container.querySelector('.wterm') as HTMLElement;
    expect(host).toBeTruthy();

    // 触发 ResizeObserver 使 viewportClientWidthPx=320（决定 minScale），flush rAF
    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // 双指张开开始（span 100px）
    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });

    // pinch in：span 100 -> 60（距离变小 = 缩小），超出 pinchRatio 触发 abort-pinch 缩放
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });

    // 终端 248px / 屏幕 200px -> minScale = 0.8065；span ratio 0.6 -> scale ~0.6，clamp 到 0.8065
    expect(scaleLayer.style.transform).toBe('scale(0.8064516129032258)');

    // 双指继续缩到更小（span 40）——clamp 在 minScale
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 170, clientY: 100, identifier: 1 },
          { clientX: 210, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    expect(scaleLayer.style.transform).toBe('scale(0.8064516129032258)');

    // 抬起结束
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });
  });

  it('keeps pure visual zoom (layout unchanged) and promotes the zoom layer to GPU compositing on pinch', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    const host = container.querySelector('.wterm') as HTMLElement;
    const fontBefore = host.style.getPropertyValue('--term-font-size');
    const rowHeightBefore = host.style.getPropertyValue('--term-row-height');

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // 双指缩小到 clamp minScale（0.8065）
    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    // pinch 中：纯视觉 zoom（布局不变）+ GPU 合成层（滚动不黑屏）
    expect(scaleLayer.style.transform).toBe('scale(0.8064516129032258)');
    expect(scaleLayer.style.willChange).toBe('transform');
    // 布局（字号/行高）完全不变
    expect(host.style.getPropertyValue('--term-font-size')).toBe(fontBefore);
    expect(host.style.getPropertyValue('--term-row-height')).toBe(rowHeightBefore);

    // 抬起结束：zoom 保持缩小（不固化、不改布局），合成层保持
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });
    expect(scaleLayer.style.transform).toBe('scale(0.8064516129032258)');
    expect(scaleLayer.style.willChange).toBe('transform');
    expect(host.style.getPropertyValue('--term-font-size')).toBe(fontBefore);
    expect(host.style.getPropertyValue('--term-row-height')).toBe(rowHeightBefore);
  });

  it('pans zoomed content vertically via translateY instead of native scroll (no black screen)', async () => {
    const { container, rerender } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    const host = container.querySelector('.wterm') as HTMLElement;

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // 双指缩小到 minScale（0.8065）→ 缩放态
    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });

    expect(scaleLayer.style.transform).toBe('scale(0.8064516129032258)');
    expect(host.style.touchAction).toBe('pan-y'); // 缩放不改变手势语义：原生滚动继续承载纵向

    // React 渲染覆盖防线：任何渲染（如 recomputeViewportRowsForZoom 的 setState）
    // 不得把 touchAction 从 pan-y 改回 none（否则原生滚动被禁用）
    const terminalProps = {
      sessionId: 's1',
      renderBufferSnapshot: buildRenderBufferSnapshot(),
      active: true,
      live: true,
      widthMode: 'mirror-fixed' as const,
      onInput: vi.fn(),
      fontSize: 5,
    };
    rerender(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView {...terminalProps} />
      </div>,
    );
    expect(host.style.touchAction).toBe('pan-y');
    expect(scaleLayer.style.transform).toBe('scale(0.8064516129032258)');

    // jsdom 无布局：mock 滚动尺寸使 maxScrollTop > 0
    Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });

    // 单指向上拖动 50px（看下面内容）→ 始终由原生 scrollTop 驱动 buffer
    act(() => {
      fireEvent.touchStart(host, {
        touches: [{ clientX: 100, clientY: 100, identifier: 1 }],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchMove(host, {
        touches: [{ clientX: 100, clientY: 50, identifier: 1 }],
        changedTouches: [],
      });
    });
    act(() => {
      host.scrollTop = 50;
      fireEvent.scroll(host);
    });
    expect((container.querySelector('.term-grid') as HTMLElement).style.transform).not.toContain('translateY');
    expect(host.scrollTop).toBe(50);
  });

  it('keeps scrollTop frozen during zoom (no black screen) and pans vertically in both directions', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    const host = container.querySelector('.wterm') as HTMLElement;

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // jsdom 无布局：mock 滚动尺寸（maxScrollTop = 1000-400 = 600）
    Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });

    // 非缩放态：原生滚动到 500px；进入缩放态后该位置必须保持（renderer 单一投影不动）
    act(() => {
      host.scrollTop = 500;
    });

    // 双指缩小到 minScale（0.8065）→ 进入缩放态
    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });

    // 缩放后 scrollTop 仍是滚动真源；纵向手势仍由原生滚动承载，网格无 translateY。
    expect(host.scrollTop).toBe(500);
    expect((container.querySelector('.term-grid') as HTMLElement).style.transform).not.toContain('translateY');

    // 单指拖动（mirror-fixed 缩放态仍是原生纵向滚动）
    const pan = (fromY: number, toY: number) => {
      act(() => {
        fireEvent.touchStart(host, {
          touches: [{ clientX: 100, clientY: fromY, identifier: 1 }],
          changedTouches: [],
        });
      });
      act(() => {
        fireEvent.touchMove(host, {
          touches: [{ clientX: 100, clientY: toY, identifier: 1 }],
          changedTouches: [],
        });
      });
      act(() => {
        fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }] });
      });
    };
    // 向下/向上拖动都保持原生滚动链路，网格不承担纵向 translate。
    pan(50, 150);
    pan(250, 50);
    expect((container.querySelector('.term-grid') as HTMLElement).style.transform).not.toContain('translateY');
    expect(host.style.touchAction).toBe('pan-y');

    // 放大回 1（步进式，computeNextPinchScale 每次 +0.08 防跳变）：多次 move 到 1
    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    for (const [x1, x2] of [
      [200, 300],
      [220, 320],
      [240, 340],
      [260, 360],
    ]) {
      act(() => {
        fireEvent.touchMove(host, {
          touches: [
            { clientX: x1, clientY: 100, identifier: 1 },
            { clientX: x2, clientY: 100, identifier: 2 },
          ],
          changedTouches: [],
        });
      });
    }
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });
    expect(scaleLayer.style.transform).toBe('none');
    expect((container.querySelector('.term-grid') as HTMLElement).style.transform).not.toContain('translateY');
    // scrollTop 仍为滚动真源——放大回 1 后位置保持（单一投影链路不再做"恢复"换算）
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.scrollTop).toBe(500);
  });

  it('does not zoom when widthMode is not mirror-fixed', () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode="adaptive-phone"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;

    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });

    expect(scaleLayer.style.transform).toBe('none'); // 非 mirror-fixed 不缩放
  });
});
