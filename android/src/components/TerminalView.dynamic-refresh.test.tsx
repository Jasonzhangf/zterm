// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';

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

function buildRows(count: number, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`);
}

function makeSession(options: {
  revision: number;
  lines: string[];
  viewportEndIndex: number;
  startIndex?: number;
}) {
  const buffer = createSessionBufferState({
    lines: options.lines,
    startIndex: options.startIndex ?? 0,
    endIndex: (options.startIndex ?? 0) + options.lines.length,
    viewportEndIndex: options.viewportEndIndex,
    rows: 24,
    cols: 80,
    revision: options.revision,
    cacheLines: 500,
  });

  const session: Session = {
    id: 's1',
    hostId: 'host-s1',
    connectionName: 'conn-s1',
    bridgeHost: '127.0.0.1',
    bridgePort: 3333,
    sessionName: 'session-s1',
    title: 'session-s1',
    ws: null,
    state: 'connected',
    hasUnread: false,
    buffer,
    createdAt: 1,
  };

  return session;
}

function readRenderedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-terminal-row="true"]'))
    .map((node) => (node.textContent || '').replace(/\s+$/u, ''));
}

describe('TerminalView minimal mirror render', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;
  let mockClientWidth = 640;
  let mockClientHeight = 408;

  beforeEach(() => {
    mockClientWidth = 640;
    mockClientHeight = 408;
    ResizeObserverMock.reset();
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return mockClientWidth;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get() {
        return mockClientHeight;
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
      return {
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 640,
        bottom: 408,
        width: 640,
        height: 17,
        toJSON() {
          return {};
        },
      } as DOMRect;
    };
    globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
  });

  afterEach(() => {
    cleanup();
    if (originalClientWidth) {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', originalClientWidth);
    }
    if (originalClientHeight) {
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', originalClientHeight);
    }
    HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    globalThis.ResizeObserver = originalResizeObserver;
    ResizeObserverMock.reset();
    vi.restoreAllMocks();
  });

  it('renders exactly one bottom screen from viewportEndIndex', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-080'));
    expect(readRenderedRows(view.container)).toContain('row-057');
  });

  it('bottom-aligns a short follow buffer instead of leaving the prompt several rows too high', async () => {
    const session = makeSession({
      revision: 1,
      lines: ['line-001', 'line-002', 'prompt-$'],
      viewportEndIndex: 3,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('prompt-$'));
    const termGrid = view.container.querySelector('.term-grid') as HTMLDivElement;
    expect(termGrid.style.paddingTop).not.toBe('0px');
  });

  it('forwards textarea input upstream but does not locally mutate rendered mirror rows', async () => {
    const onInput = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: ['stable-line-001', 'stable-line-002'],
      viewportEndIndex: 2,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    const input = view.container.querySelector('textarea[data-wterm-input="true"]') as HTMLTextAreaElement;
    expect(input).toBeTruthy();

    input.value = 'typed-from-client';
    fireEvent.input(input);

    expect(onInput).toHaveBeenCalledWith('s1', 'typed-from-client');
    expect(readRenderedRows(view.container)).toContain('stable-line-001');
    expect(readRenderedRows(view.container)).not.toContain('typed-from-client');
  });

  it('forces follow mode back to the authoritative viewport after user input', async () => {
    const onInput = vi.fn();
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });

    const input = view.container.querySelector('textarea[data-wterm-input="true"]') as HTMLTextAreaElement;
    input.value = 'x';
    fireEvent.input(input);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(80);
    });
  });

  it('emits reading viewport updates and renders gap markers when local buffer has holes', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(40),
      viewportEndIndex: 40,
    });
    session.buffer.lines[5] = [];
    session.buffer.gapRanges = [{ startIndex: 5, endIndex: 6 }];

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(onViewportChange).toHaveBeenCalled());
    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });
    expect(view.container.querySelector('[data-terminal-gap=\"true\"]')).toBeTruthy();
  });

  it('does not freeze the active follow viewport on the previous frame when latest rows contain gaps', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-080'));

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(81),
      viewportEndIndex: 81,
    });
    nextSession.buffer.lines[70] = [];
    nextSession.buffer.gapRanges = [{ startIndex: 70, endIndex: 71 }];

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferViewportEndIndex={nextSession.buffer.viewportEndIndex}
          bufferGapRanges={nextSession.buffer.gapRanges}
          cursorKeysApp={nextSession.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-081'));
    expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
  });

  it('keeps rendering latest tail rows in follow mode even when the tail window has gaps', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(120),
      viewportEndIndex: 120,
    });
    session.buffer.lines[20] = [];
    session.buffer.lines[60] = [];
    session.buffer.lines[110] = [];
    session.buffer.gapRanges = [
      { startIndex: 20, endIndex: 21 },
      { startIndex: 60, endIndex: 61 },
      { startIndex: 110, endIndex: 111 },
    ];

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-120'));
    expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
  });

  it('forces a hidden reading tab back to follow when it becomes active again', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });

    onViewportChange.mockClear();

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active={false}
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(80);
    });
  });

  it('forces the active tab back to follow when an explicit viewport reset nonce lands', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
          followResetToken={0}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });

    onViewportChange.mockClear();

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
          followResetToken={1}
        />
      </div>,
    );

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(80);
    });
  });

  it('keeps reading mode across resize observer refreshes', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(120),
      viewportEndIndex: 120,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportRows).toBe(24);
    });

    mockClientHeight = 306;
    ResizeObserverMock.triggerAll();

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportRows).toBe(18);
    });
  });

  it('keeps reading mode pinned when live buffer updates advance the same session head', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportEndIndex).toBe(24);
    });
    expect(readRenderedRows(view.container)).toContain('row-024');
    expect(readRenderedRows(view.container)).not.toContain('row-080');

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(81),
      viewportEndIndex: 81,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferViewportEndIndex={nextSession.buffer.viewportEndIndex}
          bufferGapRanges={nextSession.buffer.gapRanges}
          cursorKeysApp={nextSession.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportEndIndex).toBe(24);
    });
    expect(scroller.scrollTop).toBe(0);
    expect(readRenderedRows(view.container)).toContain('row-024');
    expect(readRenderedRows(view.container)).not.toContain('row-081');
  });

  it('anchors reading scroll position when older history rows are prepended', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 100,
      startIndex: 20,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(84, 'hist'),
      viewportEndIndex: 100,
      startIndex: 16,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferViewportEndIndex={nextSession.buffer.viewportEndIndex}
          bufferGapRanges={nextSession.buffer.gapRanges}
          cursorKeysApp={nextSession.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(68);
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });
  });

  it('switches to the next tab on left swipe', async () => {
    const onSwipeTab = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onSwipeTab={onSwipeTab}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    fireEvent.touchStart(scroller, { touches: [{ clientX: 220, clientY: 160 }] });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 120, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 120, clientY: 166 }] });

    expect(onSwipeTab).toHaveBeenCalledWith('s1', 'next');
  });

  it('switches to the previous tab on right swipe', async () => {
    const onSwipeTab = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onSwipeTab={onSwipeTab}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    fireEvent.touchStart(scroller, { touches: [{ clientX: 120, clientY: 160 }] });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 220, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 220, clientY: 166 }] });

    expect(onSwipeTab).toHaveBeenCalledWith('s1', 'previous');
  });

  it('keeps vertical scroll gestures from triggering tab swipe', async () => {
    const onSwipeTab = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onSwipeTab={onSwipeTab}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    fireEvent.touchStart(scroller, { touches: [{ clientX: 180, clientY: 220 }] });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 170, clientY: 120 }],
      cancelable: true,
    });
    fireEvent.touchEnd(scroller, { changedTouches: [{ clientX: 170, clientY: 120 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
  });

  it('anchors follow scrolling to the actual DOM bottom instead of the theoretical row math', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 1320;
      },
    });

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(81),
      viewportEndIndex: 81,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferViewportEndIndex={nextSession.buffer.viewportEndIndex}
          bufferGapRanges={nextSession.buffer.gapRanges}
          cursorKeysApp={nextSession.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(912);
    });
  });


  it('does not drift above the logical tail when DOM bottom is temporarily oversized', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 2400;
      },
    });

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(81),
      viewportEndIndex: 81,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferViewportEndIndex={nextSession.buffer.viewportEndIndex}
          bufferGapRanges={nextSession.buffer.gapRanges}
          cursorKeysApp={nextSession.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(969);
    });
  });

  it('prefetches older history and shows loading when reading reaches the cached top boundary', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      startIndex: 20,
      viewportEndIndex: 100,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    scroller.scrollTop = 0;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.prefetch).toBe(true);
      expect(lastCall?.missingRanges?.length).toBeGreaterThan(0);
      expect(lastCall?.missingRanges?.[0]?.endIndex).toBe(session.buffer.startIndex);
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeTruthy();
    });
  });

  it('uses the latest follow tail when multiple refreshes arrive before the audit timer fires', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({
        revision: 1,
        lines: buildRows(80),
        viewportEndIndex: 80,
      });

      const view = render(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={session.id}
            initialBufferLines={session.buffer.lines}
            bufferStartIndex={session.buffer.startIndex}
            bufferEndIndex={session.buffer.endIndex}
            bufferViewportEndIndex={session.buffer.viewportEndIndex}
            bufferGapRanges={session.buffer.gapRanges}
            cursorKeysApp={session.buffer.cursorKeysApp}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return 1394;
        },
      });

      const nextSession81 = makeSession({
        revision: 2,
        lines: buildRows(81),
        viewportEndIndex: 81,
      });
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={nextSession81.id}
            initialBufferLines={nextSession81.buffer.lines}
            bufferStartIndex={nextSession81.buffer.startIndex}
            bufferEndIndex={nextSession81.buffer.endIndex}
            bufferViewportEndIndex={nextSession81.buffer.viewportEndIndex}
            bufferGapRanges={nextSession81.buffer.gapRanges}
            cursorKeysApp={nextSession81.buffer.cursorKeysApp}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      const nextSession82 = makeSession({
        revision: 3,
        lines: buildRows(82),
        viewportEndIndex: 82,
      });
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={nextSession82.id}
            initialBufferLines={nextSession82.buffer.lines}
            bufferStartIndex={nextSession82.buffer.startIndex}
            bufferEndIndex={nextSession82.buffer.endIndex}
            bufferViewportEndIndex={nextSession82.buffer.viewportEndIndex}
            bufferGapRanges={nextSession82.buffer.gapRanges}
            cursorKeysApp={nextSession82.buffer.cursorKeysApp}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(986);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps rendering current rows instead of going full black when the first visible frame contains a gap', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      viewportEndIndex: 80,
    });
    session.buffer.lines[79] = [];
    session.buffer.gapRanges = [{ startIndex: 79, endIndex: 80 }];

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows.length).toBeGreaterThan(0);
      expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
    });
  });
});
