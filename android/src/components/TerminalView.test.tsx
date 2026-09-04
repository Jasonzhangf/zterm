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
      if (this.textContent === 'W' || this.textContent === '你') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 200,
          bottom: 17,
          width: 200,
          height: 17,
          toJSON() {
            return {};
          },
        } as DOMRect;
      }
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
    expect(scaleLayer.style.zoom).toBe('1'); // 初始不缩放

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
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');

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
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');

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
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    expect(scaleLayer.style.willChange).toBe('transform');
    // 布局（字号/行高）完全不变
    expect(host.style.getPropertyValue('--term-font-size')).toBe(fontBefore);
    expect(host.style.getPropertyValue('--term-row-height')).toBe(rowHeightBefore);

    // 抬起结束：zoom 保持缩小（不固化、不改布局），合成层保持
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    expect(scaleLayer.style.willChange).toBe('transform');
    expect(host.style.getPropertyValue('--term-font-size')).toBe(fontBefore);
    expect(host.style.getPropertyValue('--term-row-height')).toBe(rowHeightBefore);
  });

  it('keeps native vertical scrolling available while zoomed', async () => {
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

    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    expect(host.style.touchAction).toBe('pan-y');

    // React 渲染不能关闭缩放态的原生纵向滚动。
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
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');

    // jsdom 无布局：mock 滚动尺寸使 maxVertical > 0
    Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });

    // 单指纵向手势交给原生滚动，不由 grid transform 接管。
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
    expect(host.style.touchAction).toBe('pan-y');
    const zoomTransform = (container.querySelector('.term-grid') as HTMLElement).style.transform;
    expect(zoomTransform).not.toContain('translateY');
  });

  it('preserves the native scroll position across zoom and restores full scale', async () => {
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

    // 非缩放态：原生滚动到 500px
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

    // 缩放后仍使用原生滚动坐标，且位置被限制在新的 DOM scroll range 内。
    expect(host.scrollTop).toBe(500);

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
    // 向下/向上拖动不会生成纵向 grid transform。
    pan(50, 150);
    pan(250, 50);
    expect((container.querySelector('.term-grid') as HTMLElement).style.transform).not.toContain('translateY');
    expect(host.style.touchAction).toBe('pan-y');
    const pannedTransform = (container.querySelector('.term-grid') as HTMLElement).style.transform;
    expect(pannedTransform).not.toContain('translateY');

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
    expect(scaleLayer.style.zoom).toBe('1');
    expect((container.querySelector('.term-grid') as HTMLElement).style.transform).not.toContain('translateY');
    // scrollTop 仍为滚动真源——放大回 1 后还原到 pinch 前位置 + 缩放态 pan 位移。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.scrollTop).toBe(500);
  });

  it('clamps native scrollTop immediately while pinch is still active', async () => {
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

    const host = container.querySelector('.wterm') as HTMLElement;

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    act(() => {
      host.scrollTop = 500;
    });

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

    // zoom 可能立即缩小 scrollHeight；原生位置必须在 paint 前落入新范围。
    expect(host.scrollTop).toBeLessThanOrEqual(600);
    expect(host.scrollTop).toBeGreaterThanOrEqual(0);
  });

  it('does not add a vertical transform when saved scrollTop is large', async () => {
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

    const host = container.querySelector('.wterm') as HTMLElement;

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    act(() => {
      host.scrollTop = 500;
    });

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

    const transform = (container.querySelector('.term-grid') as HTMLElement).style.transform;
    expect(transform).not.toContain('translateY');
    expect(host.scrollTop).toBeLessThanOrEqual(600);
    expect(host.scrollTop).toBeGreaterThanOrEqual(0);
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

    expect(scaleLayer.style.zoom).toBe('1'); // 非 mirror-fixed 不缩放
  });

  it('keeps buffer row indices continuous and scrollTop unchanged across visual zoom (layer separation)', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines: Array.from({ length: 40 }, (_, i) => [
              { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
            ]),
            gapRanges: [],
            startIndex: 100,
            endIndex: 140,
            bufferHeadStartIndex: 100,
            bufferTailEndIndex: 140,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 140,
            cols: 80,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const grid = container.querySelector('.term-grid') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // jsdom 无布局：mock 滚动尺寸并滚到中部
    Object.defineProperty(host, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 400, configurable: true });
    act(() => {
      host.scrollTop = 300;
    });
    act(() => {
      fireEvent.scroll(host);
    });

    const rowIndices = () =>
      Array.from(container.querySelectorAll('[data-terminal-row="true"]'))
        .map((el) => Number(el.getAttribute('data-terminal-index')));

    const before = rowIndices();
    expect(before.length).toBeGreaterThan(0);
    for (let i = 1; i < before.length; i += 1) {
      expect(before[i] - before[i - 1]).toBe(1);
    }

    // pinch 缩小（span 100 -> 60）
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

    // 视觉缩放只改变 canvas；scrollTop 保持原生坐标，渲染窗口增加可见行数。
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    expect(host.scrollTop).toBe(300);
    expect(grid.style.transform).not.toContain('translateY');
    expect(grid.style.zoom).toBeFalsy();
    const paddingTopPx = Number.parseFloat(grid.style.paddingTop);
    const paddingBottomPx = Number.parseFloat(grid.style.paddingBottom);
    // grid padding 已在 CSS zoom 作用域内，必须按物理行高计算；
    // 若再乘 visualScale，padding 会被二次缩放并在底部留下黑屏空区。
    expect(paddingTopPx % 17).toBe(0);
    expect(paddingTopPx / 17).toBe(Math.round(paddingTopPx / 17));
    expect(paddingBottomPx / 17).toBe(Math.round(paddingBottomPx / 17));
    expect(Number.isFinite(paddingTopPx)).toBe(true);
    expect(Number.isFinite(paddingBottomPx)).toBe(true);
    const after = rowIndices();
    // The reading window is clamped to the 40-row snapshot: the scaled
    // viewport must cover the full clientHeight, so 34 rows are rendered
    // instead of leaving a partial row blank at the bottom.
    expect(after.length).toBe(34);
    for (let i = 1; i < after.length; i += 1) {
      expect(after[i] - after[i - 1]).toBe(1);
    }

    // ResizeObserver/foreground refresh 不得用未缩放的物理行高把可见行数覆盖回去。
    const rowsAfterPinch = after.length;
    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    expect(rowIndices().length).toBe(rowsAfterPinch);
  });

  it('derives a larger render window from pinch scale without scaling row height', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines: Array.from({ length: 80 }, (_, i) => [
              { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
            ]),
            gapRanges: [],
            startIndex: 0,
            endIndex: 80,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: 80,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 80,
            cols: 80,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;

    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    const beforeRows = container.querySelectorAll('[data-terminal-row="true"]').length;
    const beforeRowHeight = Number.parseFloat(
      (container.querySelector('[data-terminal-row="true"]') as HTMLElement).style.height,
    );

    Object.defineProperty(host, 'scrollHeight', { value: 1360, configurable: true });
    Object.defineProperty(host, 'clientHeight', { value: 408, configurable: true });
    act(() => {
      host.scrollTop = 816;
    });

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

    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    const afterRows = container.querySelectorAll('[data-terminal-row="true"]').length;
    const afterRowHeight = Number.parseFloat(
      (container.querySelector('[data-terminal-row="true"]') as HTMLElement).style.height,
    );

    // Pinch shrinks only the canvas; the renderer must draw a taller buffer
    // window into the same fixed 17px row height instead of shrinking rows.
    expect(afterRows).toBeGreaterThan(beforeRows);
    expect(afterRowHeight).toBe(beforeRowHeight);
    expect(afterRowHeight).toBe(17);
  });

  it('maps wide-tablet scroll-back with visual row height so history does not sit in blank padding', async () => {
    const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return 640;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      if (this.textContent === 'W' || this.textContent === '你') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 3.1,
          bottom: 17,
          width: 3.1,
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

    try {
      const { container } = render(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId="s1"
            renderBufferSnapshot={{
              lines: Array.from({ length: 120 }, (_, i) => [
                { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
              ]),
              gapRanges: [],
              startIndex: 0,
              endIndex: 120,
              bufferHeadStartIndex: 0,
              bufferTailEndIndex: 120,
              daemonHeadRevision: 1,
              daemonHeadEndIndex: 120,
              cols: 80,
              rows: 24,
              cursorKeysApp: false,
              cursor: null,
              revision: 1,
            }}
            active
            live
            widthMode="mirror-fixed"
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      const host = container.querySelector('.wterm') as HTMLElement;
      const grid = container.querySelector('.term-grid') as HTMLElement;
      const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;

      act(() => {
        ResizeObserverMock.triggerAll();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
      });

      expect(scaleLayer.style.zoom).toBe('2');
      Object.defineProperty(host, 'scrollHeight', { value: 4080, configurable: true });
      Object.defineProperty(host, 'clientHeight', { value: 408, configurable: true });
      act(() => {
        host.scrollTop = 3672;
        fireEvent.scroll(host);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      act(() => {
        host.scrollTop = 2000;
        fireEvent.scroll(host);
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      const rows = Array.from(container.querySelectorAll('[data-terminal-row="true"]'))
        .map((el) => Number(el.getAttribute('data-terminal-index')));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.some((index) => index >= 50 && index <= 80)).toBe(true);
      const paddingTopPx = Number.parseFloat(grid.style.paddingTop);
      expect(Number.isFinite(paddingTopPx)).toBe(true);
      expect(paddingTopPx % 17).toBe(0);
    } finally {
      if (originalClientWidth) {
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
      }
      if (originalGetBoundingClientRect) {
        HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      }
    }
  });

  it('keeps each intermediate pinch scale aligned with the native scroll range', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines: Array.from({ length: 100 }, (_, i) => [
              { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
            ]),
            gapRanges: [],
            startIndex: 0,
            endIndex: 100,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: 100,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 100,
            cols: 160,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    const grid = container.querySelector('.term-grid') as HTMLElement;
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      get: () => 1700 * Number(scaleLayer.style.zoom || 1),
    });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 408 });
    host.scrollTop = 800;

    const rowIndices = () => Array.from(
      container.querySelectorAll<HTMLElement>('[data-terminal-row="true"]'),
    ).map((row) => Number(row.dataset.terminalIndex));
    const rowHeight = () => Number.parseFloat(
      (container.querySelector('[data-terminal-row="true"]') as HTMLElement).style.height,
    );
    const pinchMove = (left: number, right: number) => {
      act(() => {
        fireEvent.touchMove(host, {
          touches: [
            { clientX: left, clientY: 100, identifier: 1 },
            { clientX: right, clientY: 100, identifier: 2 },
          ],
          changedTouches: [],
        });
      });
      const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
      expect(host.scrollTop).toBeLessThanOrEqual(maxScrollTop);
      expect(host.scrollTop).toBeGreaterThanOrEqual(0);
      const indices = rowIndices();
      for (let i = 1; i < indices.length; i += 1) {
        expect(indices[i] - indices[i - 1]).toBe(1);
      }
      expect(rowHeight()).toBe(17);
      expect(grid.style.transform).not.toContain('translateY');
      return indices.length;
    };

    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    const firstIntermediateRows = pinchMove(160, 240);
    const secondIntermediateRows = pinchMove(170, 230);

    expect(Number(scaleLayer.style.zoom)).toBeCloseTo(0.6, 5);
    expect(secondIntermediateRows).toBeGreaterThan(firstIntermediateRows);
  });

  it('derives one scaled renderer window when zoom commits, without scaling DOM row height', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines: Array.from({ length: 120 }, (_, i) => [
              { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
            ]),
            gapRanges: [],
            startIndex: 0,
            endIndex: 120,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: 120,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 120,
            cols: 160,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    const grid = container.querySelector('.term-grid') as HTMLElement;
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      get: () => 2040 * Number(scaleLayer.style.zoom || 1),
    });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 408 });
    host.scrollTop = 800;

    const rowCount = () =>
      container.querySelectorAll('[data-terminal-row="true"]').length;
    const rowHeight = () => Number.parseFloat(
      (container.querySelector('[data-terminal-row="true"]') as HTMLElement).style.height,
    );

    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    const rowsAtScaleOne = rowCount();
    const heightAtScaleOne = rowHeight();

    // First intermediate scale: zoom and the scaled renderer window must land
    // in the same React commit, with the fixed DOM row height unchanged.
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 170, clientY: 100, identifier: 1 },
          { clientX: 230, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    const zoomAfterFirst = Number(scaleLayer.style.zoom);
    expect(zoomAfterFirst).toBeLessThan(1);
    expect(rowCount()).toBeGreaterThan(rowsAtScaleOne);
    expect(rowHeight()).toBe(heightAtScaleOne);

    // A second smaller scale must derive a larger render window and keep the
    // native scrollTop clamped to the real zoomed DOM range.
    act(() => {
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 180, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    const zoomAfterSecond = Number(scaleLayer.style.zoom);
    expect(zoomAfterSecond).toBeLessThan(zoomAfterFirst);
    expect(rowCount()).toBeGreaterThan(rowsAtScaleOne);
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    expect(host.scrollTop).toBeLessThanOrEqual(maxScrollTop);
    expect(host.scrollTop).toBeGreaterThanOrEqual(0);
    expect(grid.style.transform).not.toContain('translateY');
  });

  it('emits a larger follow demand with visible repair ranges when pinch expands the renderer window', async () => {
    const onViewportChange = vi.fn();
    const lines = Array.from({ length: 120 }, (_, i) => [
      { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
    ]);
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines,
            gapRanges: [{ startIndex: 105, endIndex: 106 }],
            startIndex: 0,
            endIndex: 120,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: 120,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 120,
            cols: 80,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      get: () => 2040 * Number(scaleLayer.style.zoom || 1),
    });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 408 });
    host.scrollTop = 816;

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

    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1] as {
      mode?: string;
      viewportRows?: number;
      viewportEndIndex?: number;
      missingRanges?: Array<{ startIndex: number; endIndex: number }>;
    } | undefined;
    expect(lastCall?.mode).toBe('follow');
    expect(lastCall?.viewportEndIndex).toBe(120);
    expect(lastCall?.viewportRows).toBeGreaterThan(24);
    expect(lastCall?.missingRanges).toContainEqual({ startIndex: 105, endIndex: 106 });
  });

  it('keeps the scale-layer canvas height consistent with the scaled buffer rows and native scroll range after pinch shrink', async () => {
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines: Array.from({ length: 120 }, (_, i) => [
              { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
            ]),
            gapRanges: [],
            startIndex: 0,
            endIndex: 120,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: 120,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 120,
            cols: 80,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      get: () => 2040 * Number(scaleLayer.style.zoom || 1),
    });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 408 });
    host.scrollTop = 816;

    const renderedHeight = () =>
      Array.from(container.querySelectorAll<HTMLElement>('[data-terminal-row="true"]')).reduce(
        (sum, row) => sum + Number.parseFloat(row.style.height || '17'),
        0,
      );
    const before = {
      rows: container.querySelectorAll('[data-terminal-row="true"]').length,
      height: renderedHeight(),
    };

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

    const after = {
      rows: container.querySelectorAll('[data-terminal-row="true"]').length,
      height: renderedHeight(),
    };

    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');
    expect(after.rows).toBeGreaterThan(before.rows);
    expect(after.height).toBeGreaterThan(before.height);
    expect(after.height).toBeGreaterThanOrEqual(408);
    await act(async () => {
      await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const maxScrollTop = Math.max(0, host.scrollHeight - host.clientHeight);
    expect(Math.abs(host.scrollTop - maxScrollTop)).toBeLessThanOrEqual(0.01);
  });

  it('keeps processing native scroll events while pinch scale is below one', async () => {
    const onViewportChange = vi.fn();
    const lines = Array.from({ length: 120 }, (_, i) => [
      { char: 65 + (i % 26), fg: 256, bg: 256, flags: 0, width: 1 },
    ]);
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={{
            lines,
            gapRanges: [],
            startIndex: 0,
            endIndex: 120,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: 120,
            daemonHeadRevision: 1,
            daemonHeadEndIndex: 120,
            cols: 80,
            rows: 24,
            cursorKeysApp: false,
            cursor: null,
            revision: 1,
          }}
          active
          live
          widthMode="mirror-fixed"
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const host = container.querySelector('.wterm') as HTMLElement;
    const scaleLayer = container.querySelector('.term-render-scale-layer') as HTMLElement;
    Object.defineProperty(host, 'scrollHeight', {
      configurable: true,
      get: () => 2040 * Number(scaleLayer.style.zoom || 1),
    });
    Object.defineProperty(host, 'clientHeight', { configurable: true, value: 408 });
    host.scrollTop = 1632;

    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
      fireEvent.touchMove(host, {
        touches: [
          { clientX: 160, clientY: 100, identifier: 1 },
          { clientX: 220, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
    expect(scaleLayer.style.zoom).toBe('0.8064516129032258');

    onViewportChange.mockClear();
    act(() => { host.scrollTop = 0; });
    act(() => { fireEvent.scroll(host); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1] as {
      mode?: string;
      viewportRows?: number;
    } | undefined;
    expect(lastCall?.mode).toBe('reading');
    expect(lastCall?.viewportRows).toBeGreaterThan(24);
  });
});

describe('TerminalView two-finger wheel -> SGR adapter (renderer projection boundary)', () => {
  beforeEach(() => {
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
    ResizeObserverMock.reset();
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
    // @ts-expect-error test cleanup
    delete globalThis.ResizeObserver;
  });

  it('routes vertical two-finger wheel steps into onInput as SGR mouse-wheel sequences', async () => {
    const onInput = vi.fn();
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId='s1'
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode='mirror-fixed'
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );
    const host = container.querySelector('.wterm') as HTMLElement;
    expect(host).toBeTruthy();
    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });

    // 双指 100px 跨度开始，垂直下移 30px（> stepPx 24 -> 1 notch）
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
          { clientX: 150, clientY: 130, identifier: 1 },
          { clientX: 250, clientY: 130, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    act(() => {
      fireEvent.touchEnd(host, { changedTouches: [{ identifier: 1 }, { identifier: 2 }] });
    });

    // wheel down -> SGR button 65；格式 ESC[<65;col;rowM
    expect(onInput).toHaveBeenCalled();
    const sequence = onInput.mock.calls[0][1] as string;
    expect(sequence).toMatch(/^\x1b\[<65;/);
    expect(sequence).toMatch(/;\d+;\d+M$/);
    expect(onInput.mock.calls[0][0]).toBe('s1');
  });

  it('keeps the pinch path pure visual: no SGR emitted when the gesture is a pinch', async () => {
    const onInput = vi.fn();
    const { container } = render(
      <div style={{ width: '200px', height: '408px' }}>
        <TerminalView
          sessionId='s1'
          renderBufferSnapshot={buildRenderBufferSnapshot()}
          active
          live
          widthMode='mirror-fixed'
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );
    const host = container.querySelector('.wterm') as HTMLElement;
    act(() => {
      ResizeObserverMock.triggerAll();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
    act(() => {
      fireEvent.touchStart(host, {
        touches: [
          { clientX: 150, clientY: 100, identifier: 1 },
          { clientX: 250, clientY: 100, identifier: 2 },
        ],
        changedTouches: [],
      });
    });
    // span 100 -> 60：pinch（abort），不产生 wheel 输入
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
    expect(onInput).not.toHaveBeenCalled();
  });
});
