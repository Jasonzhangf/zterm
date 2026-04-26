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
  bufferTailEndIndex: number;
  startIndex?: number;
  bufferHeadStartIndex?: number;
}) {
  const buffer = createSessionBufferState({
    lines: options.lines,
    startIndex: options.startIndex ?? 0,
    endIndex: (options.startIndex ?? 0) + options.lines.length,
    bufferHeadStartIndex: options.bufferHeadStartIndex,
    bufferTailEndIndex: options.bufferTailEndIndex,
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

  it('renders exactly one bottom screen from buffer tail anchor', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 3,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 2,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          inputResetEpoch={0}
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    let currentScrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() {
        return currentScrollTop;
      },
      set(value: number) {
        currentScrollTop = value;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 1360;
      },
    });

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(952);
    });

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
      expect(onInput).toHaveBeenCalledWith(session.id, 'x');
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          inputResetEpoch={1}
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
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

  it('returns to follow when the user scrolls back to the bottom', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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

    scroller.scrollTop = 952;
    fireEvent.scroll(scroller);

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
      bufferTailEndIndex: 40,
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 81,
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
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 120,
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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

  it('rerenders immediately when active buffer content changes inside the same tail window', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      lines: [...buildRows(79), 'updated-bottom-line'],
      bufferTailEndIndex: 80,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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
      expect(readRenderedRows(view.container)).toContain('updated-bottom-line');
    });
  });

  it('forces a hidden reading tab back to follow when it becomes active again', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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

  it('forces reading mode back to follow when the input reset epoch advances', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          inputResetEpoch={0}
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

    onViewportChange.mockClear();

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          inputResetEpoch={1}
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
    expect(readRenderedRows(view.container)).toContain('row-080');
  });

  it('does not let live tail buffer updates yank a reading viewport back to follow before the user scrolls down', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(72),
      startIndex: 48,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 120,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
    let currentScrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() {
        return currentScrollTop;
      },
      set(value: number) {
        currentScrollTop = value;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 1224;
      },
    });

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(816);
    });

    scroller.scrollTop = 408;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportEndIndex).toBe(96);
    });

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(73),
      startIndex: 48,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 121,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferHeadStartIndex={nextSession.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
          daemonHeadRevision={2}
          daemonHeadEndIndex={121}
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
      expect(lastCall?.viewportEndIndex).toBe(96);
    });
  });

  it('does not let a narrowed local buffer window force reading mode back to follow without a user scroll', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(120),
      bufferTailEndIndex: 120,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
    let currentScrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get() {
        return currentScrollTop;
      },
      set(value: number) {
        currentScrollTop = value;
      },
    });
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 2040;
      },
    });

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(1632);
    });

    scroller.scrollTop = 1224;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportEndIndex).toBe(96);
    });

    const narrowedSession = makeSession({
      revision: 2,
      lines: buildRows(72),
      startIndex: 49,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 121,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={narrowedSession.id}
          initialBufferLines={narrowedSession.buffer.lines}
          bufferStartIndex={narrowedSession.buffer.startIndex}
          bufferEndIndex={narrowedSession.buffer.endIndex}
          bufferHeadStartIndex={narrowedSession.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={narrowedSession.buffer.bufferTailEndIndex}
          daemonHeadRevision={2}
          daemonHeadEndIndex={121}
          bufferGapRanges={narrowedSession.buffer.gapRanges}
          cursorKeysApp={narrowedSession.buffer.cursorKeysApp}
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
      expect(lastCall?.viewportEndIndex).toBe(96);
    });
  });

  it('forces the active tab back to follow when it is re-activated', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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

  it('keeps reading mode across resize observer refreshes', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(120),
      bufferTailEndIndex: 120,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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


  it('still lets the user scroll back down to follow after live tail updates while already in reading', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(100),
      bufferTailEndIndex: 100,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
          daemonHeadEndIndex={100}
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

    scroller.scrollTop = (100 - 24) * 17;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(100);
    });
  });

  it('keeps reading mode pinned when live buffer updates advance the same session head', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 81,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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

  it('keeps rendering the last local tail while follow demand points at a newer daemon head', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
          daemonHeadEndIndex={120}
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
      expect(lastCall?.viewportEndIndex).toBe(120);
    });
    expect(readRenderedRows(view.container)).toContain('row-080');
    expect(readRenderedRows(view.container)).not.toContain('');
    expect(view.container.querySelectorAll('[data-terminal-row="true"]').length).toBeGreaterThan(0);
  });

  it('does not move reading scroll position when older history rows are prepended', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 100,
      startIndex: 20,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 100,
      startIndex: 16,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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
      expect(scroller.scrollTop).toBe(0);
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });
  });

  it('switches to the next tab on left swipe', async () => {
    const onSwipeTab = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 81,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 81,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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

  it('requests older history but does not show loading before buffer manager reports an active pull', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      startIndex: 20,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 100,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      const readingCalls = onViewportChange.mock.calls
        .map(([, payload]) => payload)
        .filter((payload) => payload?.mode === 'reading');
      expect(readingCalls.length).toBeGreaterThan(0);
      expect(readingCalls[readingCalls.length - 1]).toMatchObject({
        mode: 'reading',
        viewportEndIndex: expect.any(Number),
        viewportRows: expect.any(Number),
      });
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    });
  });

  it('shows loading only when buffer manager marks the pull as active', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      startIndex: 20,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 100,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(true);
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
          bufferGapRanges={session.buffer.gapRanges}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          bufferPullActive
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeTruthy();
    });
  });

  it('continues requesting older history after prepend when the three-screen reading window still reaches the cache head', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      startIndex: 20,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 100,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferHeadStartIndex={session.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
      const readingCalls = onViewportChange.mock.calls.filter(([, payload]) => payload?.mode === 'reading');
      expect(readingCalls.length).toBeGreaterThan(0);
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    });

    const readingCountBeforePrepend = onViewportChange.mock.calls.filter(([, payload]) => payload?.mode === 'reading').length;

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(90),
      startIndex: 10,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 100,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          initialBufferLines={nextSession.buffer.lines}
          bufferStartIndex={nextSession.buffer.startIndex}
          bufferEndIndex={nextSession.buffer.endIndex}
          bufferHeadStartIndex={nextSession.buffer.bufferHeadStartIndex}
          bufferTailEndIndex={nextSession.buffer.bufferTailEndIndex}
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
      const readingCalls = onViewportChange.mock.calls.filter(([, payload]) => payload?.mode === 'reading');
      expect(readingCalls.length).toBeGreaterThanOrEqual(readingCountBeforePrepend);
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    });
  });

  it('enters reading on a slight upward drag near bottom and keeps the pixel scroll position', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          initialBufferLines={session.buffer.lines}
          bufferStartIndex={session.buffer.startIndex}
          bufferEndIndex={session.buffer.endIndex}
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 1360;
      },
    });

    await waitFor(() => {
      expect(scroller.scrollTop).toBe(952);
    });

    scroller.scrollTop = 944;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(scroller.scrollTop).toBe(944);
    });
  });

  it('uses the latest follow tail when multiple refreshes arrive before the audit timer fires', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({
        revision: 1,
        lines: buildRows(80),
        bufferTailEndIndex: 80,
      });

      const view = render(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={session.id}
            initialBufferLines={session.buffer.lines}
            bufferStartIndex={session.buffer.startIndex}
            bufferEndIndex={session.buffer.endIndex}
            bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
        bufferTailEndIndex: 81,
      });
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={nextSession81.id}
            initialBufferLines={nextSession81.buffer.lines}
            bufferStartIndex={nextSession81.buffer.startIndex}
            bufferEndIndex={nextSession81.buffer.endIndex}
            bufferTailEndIndex={nextSession81.buffer.bufferTailEndIndex}
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
        bufferTailEndIndex: 82,
      });
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={nextSession82.id}
            initialBufferLines={nextSession82.buffer.lines}
            bufferStartIndex={nextSession82.buffer.startIndex}
            bufferEndIndex={nextSession82.buffer.endIndex}
            bufferTailEndIndex={nextSession82.buffer.bufferTailEndIndex}
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
      bufferTailEndIndex: 80,
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
          bufferTailEndIndex={session.buffer.bufferTailEndIndex}
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
