// @vitest-environment jsdom

import type React from 'react';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView as BaseTerminalView } from './TerminalView';
import { TerminalTabSwipeSurface } from './terminal/TerminalTabSwipeSurface';
import { createSessionBufferState } from '../lib/terminal-buffer';
import { createSessionTailRefreshStore } from '../lib/session-tail-refresh-store';
import { createSessionBufferStore } from '../lib/session-buffer-store';
import { createSessionHeadStore } from '../lib/session-head-store';
import { createSessionRenderGate } from '../lib/session-render-gate';
import { createSessionRenderBufferStore } from '../lib/session-render-buffer-store';
import { applyIncomingBufferSyncRuntime } from '../contexts/session-context-buffer-runtime';
import type { Session, SessionBufferState, SessionRenderBufferSnapshot, TerminalBufferPayload, TerminalCell } from '../lib/types';

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

function makeLiveHeadStoreRef(entries?: Array<[string, any]>) {
  const liveHeads = new Map<string, any>(entries || []);
  return {
    current: {
      getLiveHead: (sessionId: string) => liveHeads.get(sessionId) || null,
      setLiveHead: (sessionId: string, head: any) => {
        liveHeads.set(sessionId, head);
        return true;
      },
      clearLiveHead: (sessionId: string) => {
        liveHeads.delete(sessionId);
      },
    },
  };
}

function buildRows(count: number, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`);
}

function cell(char: string, options?: Partial<TerminalCell>): TerminalCell {
  return {
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
    ...options,
  };
}

type TestSession = Session & {
  buffer: SessionBufferState;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
};

function makeSession(options: {
  revision: number;
  lines: string[];
  bufferTailEndIndex: number;
  startIndex?: number;
  bufferHeadStartIndex?: number;
}): TestSession {
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

  const session: TestSession = {
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

function readRenderedLineNumbers(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-terminal-line-number="true"]'))
    .map((node) => Number.parseInt(node.textContent?.trim() || '', 10))
    .filter((value) => Number.isFinite(value));
}

function readRenderedIndexedRows(container: HTMLElement) {
  return Array.from(container.querySelectorAll('[data-terminal-row="true"]'))
    .map((node) => {
      const element = node as HTMLElement;
      const absoluteIndex = Number.parseInt(element.dataset.terminalIndex || '', 10);
      return {
        absoluteIndex,
        text: element.dataset.terminalRowText ?? (element.textContent || '').replace(/\s+$/u, ''),
        isGap: element.dataset.terminalGap === 'true',
      };
    })
    .filter((row) => Number.isFinite(row.absoluteIndex));
}

function scrollFromBottomIntoReading(scroller: HTMLDivElement, bottomScrollTop = 952) {
  scroller.scrollTop = bottomScrollTop;
  fireEvent.scroll(scroller);
  scroller.scrollTop = 0;
  fireEvent.scroll(scroller);
}

function toRenderBufferSnapshot(options: {
  initialBufferLines?: TerminalCell[][];
  bufferStartIndex?: number;
  bufferEndIndex?: number;
  bufferHeadStartIndex?: number;
  bufferTailEndIndex?: number;
  bufferGapRanges?: Array<{ startIndex: number; endIndex: number }>;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
  cursorKeysApp?: boolean;
  cursor?: SessionRenderBufferSnapshot['cursor'];
  revision?: number;
  cols?: number;
}): SessionRenderBufferSnapshot {
  const lines = options.initialBufferLines || [];
  const startIndex = Math.max(0, Math.floor(options.bufferStartIndex || 0));
  const endIndex = typeof options.bufferEndIndex === 'number' && Number.isFinite(options.bufferEndIndex)
    ? Math.max(startIndex, Math.floor(options.bufferEndIndex))
    : startIndex + lines.length;
  const bufferTailEndIndex = typeof options.bufferTailEndIndex === 'number' && Number.isFinite(options.bufferTailEndIndex)
    ? Math.max(startIndex, Math.floor(options.bufferTailEndIndex))
    : endIndex;
  return {
    lines,
    gapRanges: options.bufferGapRanges || [],
    startIndex,
    endIndex,
    bufferHeadStartIndex: typeof options.bufferHeadStartIndex === 'number' && Number.isFinite(options.bufferHeadStartIndex)
      ? Math.max(0, Math.floor(options.bufferHeadStartIndex))
      : startIndex,
    bufferTailEndIndex,
    daemonHeadRevision: Math.max(0, Math.floor(options.daemonHeadRevision || 0)),
    daemonHeadEndIndex: typeof options.daemonHeadEndIndex === 'number' && Number.isFinite(options.daemonHeadEndIndex)
      ? Math.max(startIndex, Math.floor(options.daemonHeadEndIndex))
      : bufferTailEndIndex,
    cols: options.cols || 80,
    rows: 24,
    cursorKeysApp: Boolean(options.cursorKeysApp),
    cursor: options.cursor || null,
    revision: Math.max(0, Math.floor(options.revision || 0)),
  };
}

type LegacyTerminalViewProps = React.ComponentProps<typeof BaseTerminalView> & {
  initialBufferLines?: TerminalCell[][];
  bufferStartIndex?: number;
  bufferEndIndex?: number;
  bufferHeadStartIndex?: number;
  bufferTailEndIndex?: number;
  bufferGapRanges?: Array<{ startIndex: number; endIndex: number }>;
  daemonHeadRevision?: number;
  daemonHeadEndIndex?: number;
  cursorKeysApp?: boolean;
  cursor?: SessionRenderBufferSnapshot['cursor'];
};

function TerminalView({
  renderBufferSnapshot,
  initialBufferLines,
  bufferStartIndex,
  bufferEndIndex,
  bufferHeadStartIndex,
  bufferTailEndIndex,
  bufferGapRanges,
  daemonHeadRevision,
  daemonHeadEndIndex,
  cursorKeysApp,
  cursor,
  ...props
}: LegacyTerminalViewProps) {
  return (
    <BaseTerminalView
      {...props}
      renderBufferSnapshot={renderBufferSnapshot || toRenderBufferSnapshot({
        initialBufferLines,
        bufferStartIndex,
        bufferEndIndex,
        bufferHeadStartIndex,
        bufferTailEndIndex,
        bufferGapRanges,
        daemonHeadRevision,
        daemonHeadEndIndex,
        cursorKeysApp,
        cursor,
      })}
    />
  );
}

function buildTuiFrameRows(frame: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const slot = String(index).padStart(2, '0');
    if (index === 0) {
      return `frame-${String(frame).padStart(3, '0')}-head-0`;
    }
    if (index === 1) {
      return `frame-${String(frame).padStart(3, '0')}-head-1`;
    }
    if (index >= count - 3) {
      return `frame-${String(frame).padStart(3, '0')}-bottom-${slot}`;
    }
    return `frame-${String(frame).padStart(3, '0')}-body-${slot}`;
  });
}

function makeRenderSnapshotFromTextRows(options: {
  rows: string[];
  revision: number;
  startIndex?: number;
  bufferTailEndIndex?: number;
}): SessionRenderBufferSnapshot {
  const startIndex = options.startIndex ?? 0;
  const bufferTailEndIndex = options.bufferTailEndIndex ?? startIndex + options.rows.length;
  const buffer = createSessionBufferState({
    lines: options.rows,
    startIndex,
    endIndex: startIndex + options.rows.length,
    bufferHeadStartIndex: startIndex,
    bufferTailEndIndex,
    rows: 24,
    cols: 80,
    cacheLines: 500,
    revision: options.revision,
  });
  return toRenderBufferSnapshot({
    initialBufferLines: buffer.lines,
    bufferStartIndex: buffer.startIndex,
    bufferEndIndex: buffer.endIndex,
    bufferHeadStartIndex: buffer.bufferHeadStartIndex,
    bufferTailEndIndex: buffer.bufferTailEndIndex,
    bufferGapRanges: buffer.gapRanges,
    cursorKeysApp: buffer.cursorKeysApp,
    revision: buffer.revision,
  });
}

function expectRenderedRowsMatchSource(container: HTMLElement, sourceRows: string[], startIndex: number) {
  const renderedRows = readRenderedIndexedRows(container).filter((row) => !row.isGap);
  expect(renderedRows.length).toBeGreaterThan(0);
  for (const row of renderedRows) {
    const sourceOffset = row.absoluteIndex - startIndex;
    if (sourceOffset < 0 || sourceOffset >= sourceRows.length) {
      continue;
    }
    expect(row.text).toBe(sourceRows[sourceOffset]);
  }
}

function buildLargeBufferSyncPayload(rows: string[], revision: number): TerminalBufferPayload {
  return {
    revision,
    startIndex: 0,
    endIndex: rows.length,
    availableStartIndex: 0,
    availableEndIndex: rows.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    lines: rows.map((line, index) => ({
      index,
      cells: Array.from(line).map((char) => cell(char)),
    })),
  };
}

function styledTextRow(text: string, cols = 24, bg = 8): TerminalCell[] {
  const chars = Array.from(text);
  return Array.from({ length: cols }, (_, index) => {
    const char = chars[index] ?? ' ';
    return cell(char, { bg });
  });
}

function splitLargeBufferSyncPayload(payload: TerminalBufferPayload, chunkRows: number) {
  const safeChunkRows = Math.max(1, Math.floor(chunkRows));
  const chunks: TerminalBufferPayload[] = [];
  const chunkCount = Math.ceil(payload.lines.length / safeChunkRows);
  for (let offset = 0; offset < payload.lines.length; offset += safeChunkRows) {
    const lines = payload.lines.slice(offset, offset + safeChunkRows);
    const first = lines[0];
    const last = lines[lines.length - 1];
    const startIndex = first && 'index' in first ? first.index : first && 'i' in first ? first.i : offset;
    const lastIndex = last && 'index' in last ? last.index : last && 'i' in last ? last.i : offset + lines.length - 1;
    chunks.push({
      ...payload,
      startIndex,
      endIndex: lastIndex + 1,
      frameStartIndex: payload.startIndex,
      frameEndIndex: payload.endIndex,
      frameChunkIndex: chunks.length,
      frameChunkCount: chunkCount,
      generatedAt: payload.revision * 1000,
      lines,
    });
  }
  return chunks;
}

async function flushRenderGate() {
  await act(async () => {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

describe('TerminalView minimal mirror render', () => {
  const originalClientWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
  const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;
  let mockClientWidth = 640;
  let mockClientHeight = 408;

  beforeEach(() => {
    localStorage.clear();
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
      if (this.textContent === '你') {
        return {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 14,
          bottom: 17,
          width: 14,
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

  it('shows the prompt window on first frame when a tall pane has a blank lower tail', async () => {
    mockClientHeight = 595;
    const onViewportChange = vi.fn();
    const lines = ['prompt-$', ...Array.from({ length: 80 }, () => '')];
    const session = makeSession({
      revision: 1,
      lines,
      bufferTailEndIndex: 81,
    });

    const view = render(
      <div style={{ width: '640px', height: '595px' }}>
        <TerminalView
          sessionId={session.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: session.buffer.lines,
            bufferStartIndex: session.buffer.startIndex,
            bufferEndIndex: session.buffer.endIndex,
            bufferHeadStartIndex: session.buffer.bufferHeadStartIndex,
            bufferTailEndIndex: session.buffer.bufferTailEndIndex,
            bufferGapRanges: session.buffer.gapRanges,
            cursorKeysApp: session.buffer.cursorKeysApp,
            cursor: { rowIndex: 1, col: 8, visible: true },
            revision: session.buffer.revision,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('prompt-$'));
    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(2);
    });
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

  it('keeps follow-frame body truth coherent when output patches old rows and appends new tail while input stays active', async () => {
    const onInput = vi.fn();
    const baseSession = makeSession({
      revision: 1,
      lines: [
        ...buildRows(37),
        'stream-loading',
        'prompt-$',
      ],
      bufferTailEndIndex: 39,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={baseSession.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: baseSession.buffer.lines,
            bufferStartIndex: baseSession.buffer.startIndex,
            bufferEndIndex: baseSession.buffer.endIndex,
            bufferHeadStartIndex: baseSession.buffer.bufferHeadStartIndex,
            bufferTailEndIndex: baseSession.buffer.bufferTailEndIndex,
            bufferGapRanges: baseSession.buffer.gapRanges,
            cursorKeysApp: baseSession.buffer.cursorKeysApp,
            revision: baseSession.buffer.revision,
          })}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readRenderedRows(view.container)).toContain('stream-loading');
      expect(readRenderedRows(view.container)).toContain('prompt-$');
    });

    const input = view.container.querySelector('textarea[data-wterm-input="true"]') as HTMLTextAreaElement;
    input.value = 'echo hi';
    fireEvent.input(input);
    expect(onInput).toHaveBeenCalledWith('s1', 'echo hi');

    const nextLines = [
      ...buildRows(37),
      'stream-done',
      'prompt-$ echo hi',
      'tail-040',
    ];

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={baseSession.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: createSessionBufferState({
              lines: nextLines,
              startIndex: 0,
              endIndex: nextLines.length,
              bufferHeadStartIndex: 0,
              bufferTailEndIndex: nextLines.length,
              rows: 24,
              cols: 80,
              cacheLines: 500,
              revision: 2,
            }).lines,
            bufferStartIndex: 0,
            bufferEndIndex: nextLines.length,
            bufferHeadStartIndex: 0,
            bufferTailEndIndex: nextLines.length,
            bufferGapRanges: [],
            cursorKeysApp: false,
            revision: 2,
          })}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('stream-done');
      expect(rows).toContain('prompt-$ echo hi');
      expect(rows).toContain('tail-040');
      expect(rows).not.toContain('stream-loading');
      expect(rows).not.toContain('echo hi');
    });
  });

  it('black-box refreshes same-revision terminal input area text and multi-line backgrounds', async () => {
    const sessionId = 's-input-area-refresh';
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const renderGate = createSessionRenderGate({
      liveBufferStore,
      liveHeadStore,
      recordSessionRenderCommit: vi.fn(),
    });
    const renderStore = renderGate.getRenderStore();
    const initialBuffer = createSessionBufferState({
      lines: [
        'stable-output-100',
        'stable-output-101',
        styledTextRow('draft input line one'),
        styledTextRow('draft input line two'),
      ],
      startIndex: 100,
      endIndex: 104,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 104,
      rows: 24,
      cols: 24,
      revision: 10,
      cacheLines: 500,
    });
    liveBufferStore.commitBuffer(sessionId, initialBuffer);
    liveHeadStore.setHead(sessionId, {
      daemonHeadRevision: 10,
      daemonHeadEndIndex: 104,
    });

    const refs = {
      stateRef: { current: { sessions: [{ ...makeSession({ revision: 10, lines: [], bufferTailEndIndex: 104 }), id: sessionId }], activeSessionId: sessionId } },
      sessionRevisionResetRef: { current: new Map() },
      sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 10,
          latestEndIndex: 104,
          availableStartIndex: 100,
          availableEndIndex: 104,
          seenAt: Date.now(),
        }]]),
      tailRefreshStoreRef: {
        current: (() => {
          const store = createSessionTailRefreshStore();
          store.markPendingResumeTailRefresh(sessionId);
          store.recordSyncRequest(sessionId, 'tail-refresh', {
            sentAt: Date.now(),
            requestStartIndex: 100,
            requestEndIndex: 104,
            knownRevision: 10,
            localStartIndex: 100,
            localEndIndex: 104,
            targetHeadRevision: 10,
            repairSignature: '',
          });
          return store;
        })(),
      },
      bufferFrameAssemblyRef: { current: new Map() },
      sessionVisibleRangeRef: {
        current: new Map([[sessionId, { startIndex: 100, endIndex: 104, viewportRows: 4 }]]),
      },
    };

    renderGate.scheduleCommit(sessionId);
    await flushRenderGate();

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <BaseTerminalView
          sessionId={sessionId}
          sessionBufferStore={renderStore}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
          themeId="classic-dark"
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('draft input line two'));

    applyIncomingBufferSyncRuntime({
      sessionId,
      payload: {
        revision: 10,
        startIndex: 100,
        endIndex: 104,
        availableStartIndex: 100,
        availableEndIndex: 104,
        cols: 24,
        rows: 24,
        cursorKeysApp: false,
        cursor: null,
        lines: [
          { index: 100, cells: Array.from('stable-output-100').map((char) => cell(char)) },
          { index: 101, cells: Array.from('stable-output-101').map((char) => cell(char)) },
          { index: 102, cells: styledTextRow('accepted prompt ready') },
          { index: 103, cells: styledTextRow('') },
        ],
      },
      refs,
      readSessionBufferSnapshot: () => liveBufferStore.getSnapshot(sessionId).buffer,
      resolveSessionCacheLines: () => 500,
      summarizeBufferPayload: (incoming) => ({
        revision: incoming.revision,
        startIndex: incoming.startIndex,
        endIndex: incoming.endIndex,
        lineCount: incoming.lines.length,
      }),
      runtimeDebug: vi.fn(),
      commitSessionBufferUpdate: (_sessionId: string, nextBuffer: SessionBufferState) =>
        liveBufferStore.commitBuffer(_sessionId, nextBuffer),
      scheduleSessionRenderCommit: (_sessionId: string) => renderGate.scheduleCommit(_sessionId),
      isSessionTransportActive: () => true,
      requestSessionBufferSync: vi.fn(() => true),
    });
    await flushRenderGate();

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('accepted prompt ready');
      expect(rows).not.toContain('draft input line one');
      expect(rows).not.toContain('draft input line two');
    });

    const inputRows = [102, 103].map((absoluteIndex) => (
      view.container.querySelector(`[data-terminal-index="${absoluteIndex}"]`) as HTMLElement
    ));
    for (const row of inputRows) {
      expect(row).toBeTruthy();
      const cells = Array.from(row.querySelectorAll('span > span')) as HTMLSpanElement[];
      expect(cells.length).toBeGreaterThanOrEqual(24);
      const backgrounds = cells.slice(0, 24).map((node) => node.style.backgroundColor || node.style.background);
      expect(new Set(backgrounds).size).toBe(1);
      expect(backgrounds[0]).not.toBe('');
    }
  });

  it('black-box repairs a missed non-gap input row after a later sparse same-tail patch', async () => {
    const sessionId = 's-missed-non-gap-repair';
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const renderGate = createSessionRenderGate({
      liveBufferStore,
      liveHeadStore,
      recordSessionRenderCommit: vi.fn(),
    });
    const renderStore = renderGate.getRenderStore();
    const sourceStartIndex = 100;
    const initialRows = [
      'stable-output-100',
      'stable-output-101',
      styledTextRow('draft input line one'),
      styledTextRow('draft input line two'),
      'old-status-104',
    ];
    const finalSourceRows = [
      'stable-output-100',
      'stable-output-101',
      'accepted prompt ready',
      '',
      'new-status-104',
    ];
    const initialBuffer = createSessionBufferState({
      lines: initialRows,
      startIndex: sourceStartIndex,
      endIndex: sourceStartIndex + initialRows.length,
      bufferHeadStartIndex: sourceStartIndex,
      bufferTailEndIndex: sourceStartIndex + initialRows.length,
      rows: 24,
      cols: 24,
      revision: 10,
      cacheLines: 500,
    });
    liveBufferStore.commitBuffer(sessionId, initialBuffer);
    liveHeadStore.setHead(sessionId, {
      daemonHeadRevision: 10,
      daemonHeadEndIndex: 105,
    });

    const session = makeSession({ revision: 10, lines: [], bufferTailEndIndex: 105 });
    session.id = sessionId;
    session.buffer = initialBuffer;
    session.daemonHeadRevision = 11;
    session.daemonHeadEndIndex = 105;
    const refs = {
      stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
      sessionRevisionResetRef: { current: new Map() },
      sessionHeadStoreRef: makeLiveHeadStoreRef([[sessionId, {
          revision: 11,
          latestEndIndex: 105,
          availableStartIndex: 100,
          availableEndIndex: 105,
          seenAt: Date.now(),
        }]]),
      tailRefreshStoreRef: { current: createSessionTailRefreshStore() },
      bufferFrameAssemblyRef: { current: new Map() },
      sessionVisibleRangeRef: {
        current: new Map([[sessionId, { startIndex: 100, endIndex: 105, viewportRows: 5 }]]),
      },
    };
    const requestSessionBufferSync = vi.fn((_sessionId: string, requestOptions?: any) => {
      const local = liveBufferStore.getSnapshot(sessionId).buffer;
      const requestWindow = requestOptions?.requestWindowOverride || { requestStartIndex: 100, requestEndIndex: 105 };
      refs.tailRefreshStoreRef.current.recordSyncRequest(sessionId, 'reading-repair', {
        sentAt: Date.now(),
        requestStartIndex: requestWindow.requestStartIndex,
        requestEndIndex: requestWindow.requestEndIndex,
        knownRevision: local.revision,
        localStartIndex: local.startIndex,
        localEndIndex: local.endIndex,
        targetHeadRevision: 11,
        repairSignature: '',
      });
      return true;
    });
    const applyPayload = (payload: TerminalBufferPayload) => {
      refs.sessionHeadStoreRef.current.setLiveHead(sessionId, {
        revision: payload.revision,
        latestEndIndex: payload.availableEndIndex ?? payload.endIndex,
        availableStartIndex: payload.availableStartIndex ?? payload.startIndex,
        availableEndIndex: payload.availableEndIndex ?? payload.endIndex,
        seenAt: Date.now(),
      });
      liveHeadStore.setHead(sessionId, {
        daemonHeadRevision: payload.revision,
        daemonHeadEndIndex: payload.availableEndIndex ?? payload.endIndex,
      });
      applyIncomingBufferSyncRuntime({
        sessionId,
        payload,
        refs,
        readSessionBufferSnapshot: () => liveBufferStore.getSnapshot(sessionId).buffer,
        resolveSessionCacheLines: () => 500,
        summarizeBufferPayload: (incoming) => ({
          revision: incoming.revision,
          startIndex: incoming.startIndex,
          endIndex: incoming.endIndex,
          lineCount: incoming.lines.length,
        }),
        runtimeDebug: vi.fn(),
        commitSessionBufferUpdate: (_sessionId: string, nextBuffer: SessionBufferState) =>
          liveBufferStore.commitBuffer(_sessionId, nextBuffer),
        scheduleSessionRenderCommit: (_sessionId: string) => renderGate.scheduleCommit(_sessionId),
        isSessionTransportActive: () => true,
        requestSessionBufferSync,
      });
    };

    renderGate.scheduleCommit(sessionId);
    await flushRenderGate();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <BaseTerminalView
          sessionId={sessionId}
          sessionBufferStore={renderStore}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
          themeId="classic-dark"
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('draft input line two'));

    applyPayload({
      revision: 11,
      startIndex: 104,
      endIndex: 105,
      availableStartIndex: 100,
      availableEndIndex: 105,
      cols: 24,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      lines: [
        { index: 104, cells: Array.from('new-status-104').map((char) => cell(char)) },
      ],
    });
    await flushRenderGate();

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('new-status-104');
      expect(rows).toContain('draft input line two');
    });
    expect(requestSessionBufferSync).toHaveBeenCalledWith(sessionId, expect.objectContaining({
      reason: 'buffer-sync-visible-stale-non-gap-repair',
      purpose: 'reading-repair',
      requestWindowOverride: { requestStartIndex: 100, requestEndIndex: 105 },
      requestMissingRangesOverride: [{ startIndex: 100, endIndex: 105 }],
    }));

    applyPayload({
      revision: 11,
      startIndex: 100,
      endIndex: 105,
      availableStartIndex: 100,
      availableEndIndex: 105,
      cols: 24,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      lines: finalSourceRows.map((line, offset) => ({
        index: sourceStartIndex + offset,
        cells: Array.from(line).map((char) => cell(char)),
      })),
    });
    await flushRenderGate();

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('accepted prompt ready');
      expect(rows).toContain('new-status-104');
      expect(rows).not.toContain('draft input line one');
      expect(rows).not.toContain('draft input line two');
    });
    expectRenderedRowsMatchSource(view.container, finalSourceRows, sourceStartIndex);
  });

  it('keeps source, buffer, render store, and DOM coherent after more-than-screen body refreshes', async () => {
    const sessionId = 's-large-refresh';
    const liveBufferStore = createSessionBufferStore();
    const liveHeadStore = createSessionHeadStore();
    const renderCommits = vi.fn();
    const renderGate = createSessionRenderGate({
      liveBufferStore,
      liveHeadStore,
      recordSessionRenderCommit: renderCommits,
    });
    const renderStore = renderGate.getRenderStore();
    const session = makeSession({
      revision: 0,
      lines: [],
      bufferTailEndIndex: 0,
    });
    session.id = sessionId;
    session.sessionName = sessionId;
    session.title = sessionId;
    const refs = {
      stateRef: { current: { sessions: [session], activeSessionId: sessionId } },
      sessionRevisionResetRef: { current: new Map() },
      sessionHeadStoreRef: makeLiveHeadStoreRef(),
      tailRefreshStoreRef: { current: createSessionTailRefreshStore() },
      bufferFrameAssemblyRef: { current: new Map() },
      sessionVisibleRangeRef: {
        current: new Map([[sessionId, { startIndex: 0, endIndex: 24, viewportRows: 24 }]]),
      },
    };
    const requestSessionBufferSync = vi.fn(() => true);
    const applyPayload = (payload: TerminalBufferPayload) => {
      refs.sessionHeadStoreRef.current.setLiveHead(sessionId, {
        revision: payload.revision,
        latestEndIndex: payload.availableEndIndex ?? payload.endIndex,
        availableStartIndex: payload.availableStartIndex,
        availableEndIndex: payload.availableEndIndex,
        seenAt: Date.now(),
      });
      liveHeadStore.setHead(sessionId, {
        daemonHeadRevision: payload.revision,
        daemonHeadEndIndex: payload.availableEndIndex ?? payload.endIndex,
      });
      applyIncomingBufferSyncRuntime({
        sessionId,
        payload,
        refs,
        readSessionBufferSnapshot: () => liveBufferStore.getSnapshot(sessionId).buffer,
        resolveSessionCacheLines: () => 500,
        summarizeBufferPayload: (incoming) => ({
          revision: incoming.revision,
          startIndex: incoming.startIndex,
          endIndex: incoming.endIndex,
          lineCount: incoming.lines.length,
        }),
        runtimeDebug: vi.fn(),
        commitSessionBufferUpdate: (_sessionId: string, nextBuffer: SessionBufferState) =>
          liveBufferStore.commitBuffer(_sessionId, nextBuffer),
        scheduleSessionRenderCommit: (_sessionId: string) => renderGate.scheduleCommit(_sessionId),
        isSessionTransportActive: () => true,
        requestSessionBufferSync,
      });
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <BaseTerminalView
          sessionId={sessionId}
          sessionBufferStore={renderStore}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const sourceOne = Array.from({ length: 96 }, (_, index) => (
      `large-source-a-${String(index).padStart(3, '0')}-${'A'.repeat(20)}`
    ));
    const payloadOne = buildLargeBufferSyncPayload(sourceOne, 1);
    const chunksOne = splitLargeBufferSyncPayload(payloadOne, 48);
    for (let index = 0; index < chunksOne.length; index += 1) {
      applyPayload(chunksOne[index]!);
      if (index < chunksOne.length - 1) {
        await flushRenderGate();
        expect(liveBufferStore.getSnapshot(sessionId).buffer.revision).toBe(0);
        expect(renderStore.getSnapshot(sessionId).buffer.revision).toBe(0);
        expect(readRenderedRows(view.container).some((row) => row.startsWith('large-source-a-'))).toBe(false);
      }
    }
    await flushRenderGate();

    await waitFor(() => {
      expect(renderStore.getSnapshot(sessionId).buffer.revision).toBe(1);
      expect(readRenderedRows(view.container)).toContain(sourceOne[sourceOne.length - 1]);
    });
    expect(liveBufferStore.getSnapshot(sessionId).buffer.endIndex).toBe(sourceOne.length);
    expect(renderStore.getSnapshot(sessionId).buffer.endIndex).toBe(sourceOne.length);
    expectRenderedRowsMatchSource(view.container, sourceOne, 0);

    const sourceTwo = Array.from({ length: 160 }, (_, index) => (
      `large-source-b-${String(index).padStart(3, '0')}-${'B'.repeat(20)}`
    ));
    const payloadTwo = buildLargeBufferSyncPayload(sourceTwo, 2);
    const chunksTwo = splitLargeBufferSyncPayload(payloadTwo, 40);
    for (let index = 0; index < chunksTwo.length; index += 1) {
      applyPayload(chunksTwo[index]!);
      if (index < chunksTwo.length - 1) {
        await flushRenderGate();
        expect(liveBufferStore.getSnapshot(sessionId).buffer.revision).toBe(1);
        expect(renderStore.getSnapshot(sessionId).buffer.revision).toBe(1);
        const intermediateRows = readRenderedRows(view.container);
        expect(intermediateRows).toContain(sourceOne[sourceOne.length - 1]);
        expect(intermediateRows.some((row) => row.startsWith('large-source-b-'))).toBe(false);
      }
    }
    await flushRenderGate();

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(renderStore.getSnapshot(sessionId).buffer.revision).toBe(2);
      expect(rows).toContain(sourceTwo[sourceTwo.length - 1]);
      expect(rows).not.toContain(sourceOne[sourceOne.length - 1]);
    });
    expect(liveBufferStore.getSnapshot(sessionId).buffer.endIndex).toBe(sourceTwo.length);
    expect(renderStore.getSnapshot(sessionId).buffer.endIndex).toBe(sourceTwo.length);
    expectRenderedRowsMatchSource(view.container, sourceTwo, 0);
    expect(requestSessionBufferSync).not.toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({ reason: 'buffer-sync-revision-gap-sparse-payload' }),
    );
    expect(renderCommits).toHaveBeenCalledTimes(2);
  });

  it('keeps bottom rows scoped to the active session across switch, late old-session publish, and IME layout refresh', async () => {
    const renderStore = createSessionRenderBufferStore();
    const sessionARows = [
      ...buildRows(36, 'session-a-body'),
      'session-a-bottom-prompt',
      'session-a-bottom-status',
    ];
    const sessionBRows = [
      ...buildRows(36, 'session-b-body'),
      'session-b-bottom-prompt',
      'session-b-bottom-status',
    ];
    const sessionALateRows = [
      ...buildRows(36, 'session-a-late-body'),
      'session-a-late-bottom-prompt',
      'session-a-late-bottom-status',
    ];

    renderStore.setBuffer('s-a', makeRenderSnapshotFromTextRows({
      rows: sessionARows,
      revision: 1,
    }));
    renderStore.setBuffer('s-b', makeRenderSnapshotFromTextRows({
      rows: sessionBRows,
      revision: 1,
    }));

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <BaseTerminalView
          sessionId="s-a"
          sessionBufferStore={renderStore}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('session-a-bottom-status'));
    expect(readRenderedRows(view.container)).not.toContain('session-b-bottom-status');

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <BaseTerminalView
          sessionId="s-b"
          sessionBufferStore={renderStore}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('session-b-bottom-status');
      expect(rows).not.toContain('session-a-bottom-status');
    });

    expect(renderStore.setBuffer('s-a', makeRenderSnapshotFromTextRows({
      rows: sessionALateRows,
      revision: 2,
    }))).toBe(true);

    await act(async () => {
      mockClientHeight = 320;
      ResizeObserverMock.triggerAll();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('session-b-bottom-status');
      expect(rows).toContain('session-b-bottom-prompt');
      expect(rows).not.toContain('session-a-bottom-status');
      expect(rows).not.toContain('session-a-bottom-prompt');
      expect(rows).not.toContain('session-a-late-bottom-status');
      expect(rows).not.toContain('session-a-late-bottom-prompt');
    });

    view.rerender(
      <div style={{ width: '640px', height: '320px' }}>
        <BaseTerminalView
          sessionId="s-a"
          sessionBufferStore={renderStore}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      expect(rows).toContain('session-a-late-bottom-status');
      expect(rows).toContain('session-a-late-bottom-prompt');
      expect(rows).not.toContain('session-b-bottom-status');
      expect(rows).not.toContain('session-b-bottom-prompt');
    });
  });

  it('does not rebind dom input listeners when live buffer updates only change cursor key mode', async () => {
    const addEventListenerSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'addEventListener');
    const removeEventListenerSpy = vi.spyOn(HTMLTextAreaElement.prototype, 'removeEventListener');
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
          cursorKeysApp={false}
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    const initialAddCount = addEventListenerSpy.mock.calls.length;
    const initialRemoveCount = removeEventListenerSpy.mock.calls.length;

    const nextSession = makeSession({
      revision: 2,
      lines: ['stable-line-001', 'stable-line-002', 'stable-line-003'],
      bufferTailEndIndex: 3,
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
          cursorKeysApp
          active
          allowDomFocus
          onResize={vi.fn()}
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    expect(addEventListenerSpy.mock.calls.length).toBe(initialAddCount);
    expect(removeEventListenerSpy.mock.calls.length).toBe(initialRemoveCount);

    const input = view.container.querySelector('textarea[data-wterm-input="true"]') as HTMLTextAreaElement;
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(onInput).toHaveBeenLastCalledWith(nextSession.id, '\x1bOA');
  });

  it('does not let renderer subscribe to daemon head metadata without a body repaint', async () => {
    vi.useFakeTimers();
    try {
      const onViewportChange = vi.fn();
      const renderStore = createSessionRenderBufferStore();
      const session = makeSession({
        revision: 1,
        lines: buildRows(80),
        bufferTailEndIndex: 80,
      });
      renderStore.setBuffer(session.id, toRenderBufferSnapshot({
        initialBufferLines: session.buffer.lines,
        bufferStartIndex: session.buffer.startIndex,
        bufferEndIndex: session.buffer.endIndex,
        bufferHeadStartIndex: session.buffer.bufferHeadStartIndex,
        bufferTailEndIndex: session.buffer.bufferTailEndIndex,
        bufferGapRanges: session.buffer.gapRanges,
        revision: session.buffer.revision,
      }));
      const view = render(
        <div style={{ width: '640px', height: '408px' }}>
          <BaseTerminalView
            sessionId={session.id}
            sessionBufferStore={renderStore}
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
      let scrollTopWriteCount = 0;
      Object.defineProperty(scroller, 'scrollTop', {
        configurable: true,
        get() {
          return currentScrollTop;
        },
        set(value: number) {
          scrollTopWriteCount += 1;
          currentScrollTop = value;
        },
      });
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return 1360;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(currentScrollTop).toBe(952);
      const initialScrollTopWriteCount = scrollTopWriteCount;
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 80,
        viewportRows: 24,
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(readRenderedRows(view.container)).toContain('row-080');
      expect(currentScrollTop).toBe(952);
      expect(scrollTopWriteCount).toBe(initialScrollTopWriteCount);
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 80,
        viewportRows: 24,
      });
    } finally {
      vi.useRealTimers();
    }
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

    scrollFromBottomIntoReading(scroller);

    await waitFor(() => {
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(true);
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
    let currentScrollHeight = 2040;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return currentScrollHeight;
      },
    });
    scrollFromBottomIntoReading(scroller);

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

  it('aligns to follow before activating input from reading mode', async () => {
    const onViewportChange = vi.fn();
    const onActivateInput = vi.fn();
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
          allowDomFocus={false}
          onActivateInput={onActivateInput}
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
        return 2040;
      },
    });
    scrollFromBottomIntoReading(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportEndIndex).toBe(24);
    });

    fireEvent.click(scroller);

    expect(onActivateInput).toHaveBeenCalledWith(session.id);
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
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 680;
      },
    });
    scroller.scrollTop = 272;
    fireEvent.scroll(scroller);
    scrollFromBottomIntoReading(scroller);

    await waitFor(() => {
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(true);
    });
    expect(
      onViewportChange.mock.calls.some(([, payload]) =>
        payload?.mode === 'reading'
        && JSON.stringify(payload?.missingRanges) === JSON.stringify([{ startIndex: 5, endIndex: 6 }]),
      ),
    ).toBe(true);
    expect(view.container.querySelector('[data-terminal-gap=\"true\"]')).toBeTruthy();
  });

  it('automatically reports visible follow gaps as missingRanges from the shared renderer core', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(120),
      bufferTailEndIndex: 120,
    });
    session.buffer.lines[110] = [];
    session.buffer.gapRanges = [{ startIndex: 110, endIndex: 111 }];

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

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-120'));
    await waitFor(() => {
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 120,
        viewportRows: 24,
        missingRanges: [{ startIndex: 110, endIndex: 111 }],
      });
    });
    expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
  });

  it('re-reports visible follow gaps when gapRanges change without a geometry revision change', async () => {
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
          bufferGapRanges={[]}
          cursorKeysApp={session.buffer.cursorKeysApp}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-120'));
    await waitFor(() => {
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 120,
        viewportRows: 24,
      });
    });
    onViewportChange.mockClear();

    const nextLines = session.buffer.lines.slice();
    nextLines[110] = [];
    await act(async () => {
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId={session.id}
            initialBufferLines={nextLines}
            bufferStartIndex={session.buffer.startIndex}
            bufferEndIndex={session.buffer.endIndex}
            bufferTailEndIndex={session.buffer.bufferTailEndIndex}
            bufferGapRanges={[{ startIndex: 110, endIndex: 111 }]}
            cursorKeysApp={session.buffer.cursorKeysApp}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            onViewportChange={onViewportChange}
            fontSize={5}
          />
        </div>,
      );
    });

    await waitFor(() => {
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 120,
        viewportRows: 24,
        missingRanges: [{ startIndex: 110, endIndex: 111 }],
      });
    });
    expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
  });

  it('re-reports the same visible follow gap after a newer buffer revision leaves it unrepaired', async () => {
    const onViewportChange = vi.fn();
    const rows = buildRows(120);
    const baseSnapshot = makeRenderSnapshotFromTextRows({
      rows,
      revision: 1,
      startIndex: 0,
      bufferTailEndIndex: 120,
    });
    const gapRows = baseSnapshot.lines.slice();
    gapRows[110] = [];
    const gapSnapshot = toRenderBufferSnapshot({
      initialBufferLines: gapRows,
      bufferStartIndex: 0,
      bufferEndIndex: 120,
      bufferTailEndIndex: 120,
      bufferGapRanges: [{ startIndex: 110, endIndex: 111 }],
      revision: 1,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s-gap-repeat"
          renderBufferSnapshot={gapSnapshot}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(onViewportChange).toHaveBeenLastCalledWith('s-gap-repeat', {
        mode: 'follow',
        viewportEndIndex: 120,
        viewportRows: 24,
        missingRanges: [{ startIndex: 110, endIndex: 111 }],
      });
    });
    onViewportChange.mockClear();

    const newerGapRows = gapRows.slice();
    newerGapRows[119] = Array.from('newer-tail-row').map((char) => cell(char));
    const newerGapSnapshot = toRenderBufferSnapshot({
      initialBufferLines: newerGapRows,
      bufferStartIndex: 0,
      bufferEndIndex: 120,
      bufferTailEndIndex: 120,
      bufferGapRanges: [{ startIndex: 110, endIndex: 111 }],
      revision: 2,
    });

    await act(async () => {
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId="s-gap-repeat"
            renderBufferSnapshot={newerGapSnapshot}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
            onViewportChange={onViewportChange}
            fontSize={5}
          />
        </div>,
      );
    });

    await waitFor(() => {
      expect(onViewportChange).toHaveBeenLastCalledWith('s-gap-repeat', {
        mode: 'follow',
        viewportEndIndex: 120,
        viewportRows: 24,
        missingRanges: [{ startIndex: 110, endIndex: 111 }],
      });
    });
    expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
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

  it('realigns scroll synchronously after a large follow update so the viewport does not stay blank until user scrolls', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(30),
      bufferTailEndIndex: 30,
    });
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: session.buffer.lines,
            bufferStartIndex: session.buffer.startIndex,
            bufferEndIndex: session.buffer.endIndex,
            bufferTailEndIndex: session.buffer.bufferTailEndIndex,
            bufferGapRanges: session.buffer.gapRanges,
            revision: session.buffer.revision,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    let currentScrollTop = 0;
    let currentScrollHeight = 510;
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
        return currentScrollHeight;
      },
    });

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-030'));
    await waitFor(() => expect(currentScrollTop).toBe(102));

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(90),
      bufferTailEndIndex: 90,
    });
    currentScrollHeight = 1530;

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={nextSession.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: nextSession.buffer.lines,
            bufferStartIndex: nextSession.buffer.startIndex,
            bufferEndIndex: nextSession.buffer.endIndex,
            bufferTailEndIndex: nextSession.buffer.bufferTailEndIndex,
            bufferGapRanges: nextSession.buffer.gapRanges,
            revision: nextSession.buffer.revision,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('row-090'));
    await waitFor(() => expect(currentScrollTop).toBe(1122));
  });

  it('realigns follow when the local buffer window jumps to a new absolute range', async () => {
    const initial = makeSession({
      revision: 1,
      lines: buildRows(30, 'old'),
      bufferTailEndIndex: 30,
    });
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={initial.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: initial.buffer.lines,
            bufferStartIndex: initial.buffer.startIndex,
            bufferEndIndex: initial.buffer.endIndex,
            bufferTailEndIndex: initial.buffer.bufferTailEndIndex,
            bufferGapRanges: initial.buffer.gapRanges,
            revision: initial.buffer.revision,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    let currentScrollTop = 0;
    let currentScrollHeight = 510;
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
        return currentScrollHeight;
      },
    });

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('old-030'));
    await waitFor(() => expect(currentScrollTop).toBe(102));

    const shifted = makeSession({
      revision: 2,
      lines: buildRows(90, 'new'),
      startIndex: 500,
      bufferTailEndIndex: 590,
    });
    currentScrollHeight = 1530;

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={shifted.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: shifted.buffer.lines,
            bufferStartIndex: shifted.buffer.startIndex,
            bufferEndIndex: shifted.buffer.endIndex,
            bufferTailEndIndex: shifted.buffer.bufferTailEndIndex,
            bufferGapRanges: shifted.buffer.gapRanges,
            revision: shifted.buffer.revision,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    expect(currentScrollTop).toBe(1122);
    await waitFor(() => expect(readRenderedRows(view.container)).toContain('new-090'));
    expect(readRenderedRows(view.container)).not.toContain('old-030');
    await waitFor(() => expect(currentScrollTop).toBe(1122));
  });

  it('rebuilds render rows when a fixed bottom row is replaced inside the same lines container', async () => {
    const session = makeSession({
      revision: 1,
      lines: [...buildRows(79), 'fixed-bottom-old'],
      bufferTailEndIndex: 80,
    });
    const sharedLines = session.buffer.lines;
    const sharedGapRanges: Array<{ startIndex: number; endIndex: number }> = [];
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: sharedLines,
            bufferStartIndex: session.buffer.startIndex,
            bufferEndIndex: session.buffer.endIndex,
            bufferTailEndIndex: session.buffer.bufferTailEndIndex,
            bufferGapRanges: sharedGapRanges,
            revision: 1,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('fixed-bottom-old'));

    sharedLines[79] = Array.from('fixed-bottom-new').map((char) => cell(char));

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={session.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: sharedLines,
            bufferStartIndex: session.buffer.startIndex,
            bufferEndIndex: session.buffer.endIndex,
            bufferTailEndIndex: session.buffer.bufferTailEndIndex,
            bufferGapRanges: sharedGapRanges,
            revision: 2,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('fixed-bottom-new'));
    expect(readRenderedRows(view.container)).not.toContain('fixed-bottom-old');
  });

  it('black-box compares final TUI source rows with rendered DOM after rapid full-screen refreshes', async () => {
    let sourceRows = buildTuiFrameRows(0, 24);
    const startIndex = 400;

    const renderSnapshot = (rows: string[], revision: number) => {
      const buffer = createSessionBufferState({
        lines: rows,
        startIndex,
        endIndex: startIndex + rows.length,
        bufferHeadStartIndex: startIndex,
        bufferTailEndIndex: startIndex + rows.length,
        rows: 24,
        cols: 80,
        cacheLines: 500,
        revision,
      });
      return toRenderBufferSnapshot({
        initialBufferLines: buffer.lines,
        bufferStartIndex: buffer.startIndex,
        bufferEndIndex: buffer.endIndex,
        bufferHeadStartIndex: buffer.bufferHeadStartIndex,
        bufferTailEndIndex: buffer.bufferTailEndIndex,
        bufferGapRanges: buffer.gapRanges,
        revision: buffer.revision,
      });
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={renderSnapshot(sourceRows, 1)}
          active
          showAbsoluteLineNumbers
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readRenderedIndexedRows(view.container).map((row) => row.text)).toContain('frame-000-bottom-23');
    });

    for (let frame = 1; frame <= 18; frame += 1) {
      sourceRows = buildTuiFrameRows(frame, 24);
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId="s1"
            renderBufferSnapshot={renderSnapshot(sourceRows, frame + 1)}
            active
            showAbsoluteLineNumbers
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );
    }

    await waitFor(() => {
      expect(readRenderedIndexedRows(view.container).map((row) => row.text)).toContain('frame-018-bottom-23');
    });
    expectRenderedRowsMatchSource(view.container, sourceRows, startIndex);
    const finalRows = readRenderedIndexedRows(view.container).map((row) => row.text);
    expect(finalRows).toContain('frame-018-head-0');
    expect(finalRows).toContain('frame-018-bottom-23');
    expect(finalRows.some((row) => row.startsWith('frame-017-'))).toBe(false);
  });

  it('repaints full-screen TUI status-row styles even when row text and absolute indexes stay the same', async () => {
    const startIndex = 520;
    const buildStyledFrame = (background: number) => Array.from({ length: 24 }, (_, index) => {
      const text = index === 0
        ? 'stable-fullscreen-status'
        : `stable-fullscreen-row-${String(index).padStart(2, '0')}`;
      return Array.from(text).map((char) => cell(char, { bg: background }));
    });
    const renderSnapshot = (rows: TerminalCell[][], revision: number) => toRenderBufferSnapshot({
      initialBufferLines: rows,
      bufferStartIndex: startIndex,
      bufferEndIndex: startIndex + rows.length,
      bufferHeadStartIndex: startIndex,
      bufferTailEndIndex: startIndex + rows.length,
      revision,
    });
    const readFirstCellBackground = (container: HTMLElement) => {
      const row = container.querySelector(`[data-terminal-index="${startIndex}"]`) as HTMLElement | null;
      expect(row).toBeTruthy();
      const cellSpan = row!.querySelector('span > span') as HTMLSpanElement | null;
      expect(cellSpan).toBeTruthy();
      return cellSpan!.style.backgroundColor || cellSpan!.style.background;
    };

    const firstFrame = buildStyledFrame(1);
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s-fullscreen-style"
          renderBufferSnapshot={renderSnapshot(firstFrame, 1)}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readRenderedIndexedRows(view.container).map((row) => row.text)).toContain('stable-fullscreen-status');
    });
    const firstBackground = readFirstCellBackground(view.container);

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s-fullscreen-style"
          renderBufferSnapshot={renderSnapshot(buildStyledFrame(2), 2)}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readFirstCellBackground(view.container)).not.toBe(firstBackground);
    });
    expect(readRenderedIndexedRows(view.container).find((row) => row.absoluteIndex === startIndex)?.text)
      .toBe('stable-fullscreen-status');
  });

  it('black-box compares large same-window source refreshes with rendered tail output', async () => {
    let sourceRows = buildTuiFrameRows(0, 160);
    const startIndex = 1000;

    const renderSnapshot = (rows: string[], revision: number) => {
      const buffer = createSessionBufferState({
        lines: rows,
        startIndex,
        endIndex: startIndex + rows.length,
        bufferHeadStartIndex: startIndex,
        bufferTailEndIndex: startIndex + rows.length,
        rows: 24,
        cols: 80,
        cacheLines: 500,
        revision,
      });
      return toRenderBufferSnapshot({
        initialBufferLines: buffer.lines,
        bufferStartIndex: buffer.startIndex,
        bufferEndIndex: buffer.endIndex,
        bufferHeadStartIndex: buffer.bufferHeadStartIndex,
        bufferTailEndIndex: buffer.bufferTailEndIndex,
        bufferGapRanges: buffer.gapRanges,
        revision: buffer.revision,
      });
    };

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s1"
          renderBufferSnapshot={renderSnapshot(sourceRows, 1)}
          active
          showAbsoluteLineNumbers
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readRenderedIndexedRows(view.container).map((row) => row.text)).toContain('frame-000-bottom-159');
    });

    for (let frame = 1; frame <= 12; frame += 1) {
      sourceRows = buildTuiFrameRows(frame, 160);
      view.rerender(
        <div style={{ width: '640px', height: '408px' }}>
          <TerminalView
            sessionId="s1"
            renderBufferSnapshot={renderSnapshot(sourceRows, frame + 1)}
            active
            showAbsoluteLineNumbers
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );
    }

    await waitFor(() => {
      expect(readRenderedIndexedRows(view.container).map((row) => row.text)).toContain('frame-012-bottom-159');
    });
    expectRenderedRowsMatchSource(view.container, sourceRows, startIndex);
    expect(readRenderedIndexedRows(view.container).some((row) => row.text.startsWith('frame-011-'))).toBe(false);
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
    let currentScrollHeight = 2040;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return currentScrollHeight;
      },
    });
    scrollFromBottomIntoReading(scroller);

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
    let currentScrollHeight = 2040;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return currentScrollHeight;
      },
    });
    scrollFromBottomIntoReading(scroller);

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
    let currentScrollHeight = 2040;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return currentScrollHeight;
      },
    });
    scrollFromBottomIntoReading(scroller);

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
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return 1360;
      },
    });
    scrollFromBottomIntoReading(scroller);

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

  it('realigns reading scroll after a large buffer shift so the old viewport does not sit in blank padding', async () => {
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
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: session.buffer.lines,
            bufferStartIndex: session.buffer.startIndex,
            bufferEndIndex: session.buffer.endIndex,
            bufferTailEndIndex: session.buffer.bufferTailEndIndex,
            bufferGapRanges: session.buffer.gapRanges,
            revision: session.buffer.revision,
          })}
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

    scroller.scrollTop = 1632;
    fireEvent.scroll(scroller);
    scroller.scrollTop = 816;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
    });

    const shifted = makeSession({
      revision: 2,
      lines: buildRows(120, 'shifted'),
      startIndex: 100000,
      bufferTailEndIndex: 100120,
    });

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={shifted.id}
          renderBufferSnapshot={toRenderBufferSnapshot({
            initialBufferLines: shifted.buffer.lines,
            bufferStartIndex: shifted.buffer.startIndex,
            bufferEndIndex: shifted.buffer.endIndex,
            bufferTailEndIndex: shifted.buffer.bufferTailEndIndex,
            bufferGapRanges: shifted.buffer.gapRanges,
            revision: shifted.buffer.revision,
          })}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(currentScrollTop).toBe(0);
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(readRenderedRows(view.container)).toContain('shifted-001');
    });
  });

  it('does not recreate the resize observer just because viewport state updated after an observer tick', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(120),
      bufferTailEndIndex: 120,
    });

    render(
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

    expect(ResizeObserverMock.instances.size).toBe(1);
    const firstObserver = Array.from(ResizeObserverMock.instances)[0];
    expect(firstObserver).toBeTruthy();

    mockClientHeight = 306;
    ResizeObserverMock.triggerAll();

    await waitFor(() => {
      expect(ResizeObserverMock.instances.size).toBe(1);
    });
    expect(Array.from(ResizeObserverMock.instances)[0]).toBe(firstObserver);
  });

  it('realigns follow scroll to the new DOM bottom when viewport rows change, instead of leaving a blank overscrolled frame', async () => {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('row-080');

      mockClientHeight = 510;
      scrollHeight = 1360;
      act(() => {
        ResizeObserverMock.triggerAll();
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(850);
      expect(readRenderedRows(view.container)).toContain('row-080');
    } finally {
      vi.useRealTimers();
    }
  });

  it('realigns follow scroll when DOM height changes but logical viewport rows stay the same, so the bottom prompt/cursor stays visible', async () => {
    vi.useFakeTimers();
    try {
      const session = makeSession({
        revision: 1,
        lines: [...buildRows(79), 'prompt-$'],
        bufferTailEndIndex: 80,
      });
      session.buffer.lines[79] = [
        ...Array.from('prompt-$').map((char) => ({
          char: char.codePointAt(0) || 32,
          fg: 256,
          bg: 256,
          flags: 0,
          width: 1 as const,
        })),
        {
          char: 32,
          fg: 256,
          bg: 256,
          flags: 0,
          width: 1,
        },
      ];
      session.buffer.cursor = { rowIndex: 79, col: 7, visible: true };

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
            cursor={session.buffer.cursor}
            active
            onResize={vi.fn()}
            onInput={vi.fn()}
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

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('prompt-$');
      expect(view.container.querySelector('[data-terminal-cursor="true"]')).toBeTruthy();

      mockClientHeight = 415;
      act(() => {
        ResizeObserverMock.triggerAll();
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(945);
      expect(readRenderedRows(view.container)).toContain('prompt-$');
      expect(view.container.querySelector('[data-terminal-cursor="true"]')).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps zoom follow pinned to the live DOM bottom when quickbar shrinks the stage in the same batch as a tail refresh', async () => {
    const initialRows = buildRows(80);
    const initialSnapshot = toRenderBufferSnapshot({
      initialBufferLines: initialRows.map((line) => Array.from(line).map((char) => cell(char))),
      bufferStartIndex: 0,
      bufferEndIndex: initialRows.length,
      bufferTailEndIndex: initialRows.length,
      cols: 20,
      revision: 1,
    });
    const nextRows = [...buildRows(79), 'quickbar-live-bottom'];
    const nextSnapshot = toRenderBufferSnapshot({
      initialBufferLines: nextRows.map((line) => Array.from(line).map((char) => cell(char))),
      bufferStartIndex: 0,
      bufferEndIndex: nextRows.length,
      bufferTailEndIndex: nextRows.length,
      cols: 20,
      revision: 2,
    });

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s-quickbar-zoom"
          renderBufferSnapshot={initialSnapshot}
          active
          live
          widthMode="mirror-fixed"
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    const scaleLayer = view.container.querySelector('.term-render-scale-layer') as HTMLElement;

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
    const zoomedContentHeight = 80 * 17 * 2; // 80 rows * physical 17px * visualScale 2
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return zoomedContentHeight;
      },
    });
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      get() {
        return mockClientHeight;
      },
    });

    await act(async () => {
      ResizeObserverMock.triggerAll();
      await new Promise((resolve) => {
        window.setTimeout(resolve, 25);
      });
    });
    expect(scaleLayer.style.zoom).toBe('2');
    expect(currentScrollTop).toBe(zoomedContentHeight - mockClientHeight);
    expect(readRenderedRows(view.container)).toContain('row-080');

    // Quickbar appears: the real DOM height shrinks, but the renderer state
    // still holds the previous clientHeight until ResizeObserver commits.
    mockClientHeight = 306;
    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="s-quickbar-zoom"
          renderBufferSnapshot={nextSnapshot}
          active
          live
          widthMode="mirror-fixed"
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(currentScrollTop).toBe(zoomedContentHeight - mockClientHeight);
    expect(readRenderedRows(view.container)).toContain('quickbar-live-bottom');
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
    scrollFromBottomIntoReading(scroller);

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

  it('returns to follow when a buffer re-anchor leaves the reading viewport physically at the bottom', async () => {
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
    let currentScrollHeight = 2040;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return currentScrollHeight;
      },
    });
    scrollFromBottomIntoReading(scroller);

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('reading');
      expect(lastCall?.viewportEndIndex).toBe(24);
    });

    const reanchoredTail = makeSession({
      revision: 2,
      lines: buildRows(24),
      startIndex: 56,
      bufferTailEndIndex: 80,
    });
    currentScrollHeight = 408;

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={reanchoredTail.id}
          initialBufferLines={reanchoredTail.buffer.lines}
          bufferStartIndex={reanchoredTail.buffer.startIndex}
            bufferEndIndex={reanchoredTail.buffer.endIndex}
            bufferTailEndIndex={reanchoredTail.buffer.bufferTailEndIndex}
            bufferGapRanges={reanchoredTail.buffer.gapRanges}
            cursorKeysApp={reanchoredTail.buffer.cursorKeysApp}
            cursor={session.buffer.cursor}
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

    expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeNull();
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
    scrollFromBottomIntoReading(scroller);

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

  it('emits at most one follow viewport update for a single live tail advance while already following', async () => {
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

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(80);
    });

    onViewportChange.mockClear();

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
      const followCalls = onViewportChange.mock.calls
        .map(([, payload]) => payload)
        .filter((payload) => payload?.mode === 'follow' && payload?.viewportEndIndex === 81);
      expect(followCalls.length).toBeLessThanOrEqual(1);
      expect(followCalls[0]).toMatchObject({
        mode: 'follow',
        viewportEndIndex: 81,
        viewportRows: expect.any(Number),
      });
    });
  });

  it('keeps follow demand anchored to the last local tail instead of daemon head metadata', async () => {
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

    await waitFor(() => {
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(lastCall?.viewportEndIndex).toBe(80);
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
    scrollFromBottomIntoReading(scroller);

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

  it('renders body rows from payload truth without letting cursor metadata pollute neighbouring styled CJK cells', async () => {
    const mixedRow: TerminalCell[] = [
      cell('A'),
      cell(' ', { bg: 8 }),
      cell('你', { fg: 6, width: 2 }),
      { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
      cell('好', { fg: 6, width: 2 }),
      { char: 32, fg: 6, bg: 256, flags: 0, width: 0 },
      cell('B'),
    ];
    const buffer = createSessionBufferState({
      lines: [mixedRow],
      startIndex: 100,
      endIndex: 101,
      bufferHeadStartIndex: 100,
      bufferTailEndIndex: 101,
      rows: 24,
      cols: 80,
      revision: 1,
      cursor: {
        rowIndex: 100,
        col: 2,
        visible: true,
      },
      cacheLines: 500,
    });
    const session: TestSession = {
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
          cursor={session.buffer.cursor}
          active
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('A 你好B'));

    const activeRow = view.container.querySelector('[data-terminal-index="100"]') as HTMLDivElement;
    const cellContainer = activeRow.querySelector('span:last-child') as HTMLSpanElement;
    const cells = Array.from(cellContainer.querySelectorAll('span'));
    expect(cells).toHaveLength(7);
    expect(cells[2]?.getAttribute('data-terminal-cursor')).toBe('true');
    expect(cells[3]?.getAttribute('data-terminal-cursor')).toBeNull();
    expect(cells[4]?.getAttribute('data-terminal-cursor')).toBeNull();
    expect(cells[1]?.style.background).not.toBe('');
    expect(cells[2]?.style.color).not.toBe('');
    expect(cells[4]?.style.color).not.toBe('');
  });

  it('does not emit upstream resize writes when mirror-fixed width mode is enabled', async () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    const fixedWidthProps = {
      widthMode: 'mirror-fixed',
    } as any;

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
          onResize={onResize}
          onInput={vi.fn()}
          fontSize={5}
          {...fixedWidthProps}
        />
      </div>,
    );

    mockClientWidth = 320;
    act(() => {
      ResizeObserverMock.triggerAll();
      vi.runAllTimers();
    });

    expect(onResize).not.toHaveBeenCalled();
    view.unmount();
    vi.useRealTimers();
  });

  it('keeps adaptive-phone rows fixed-height so virtual scrolling and IME bottom alignment stay stable', async () => {
    const wideRow = '1234567890'.repeat(8);
    const session = makeSession({
      revision: 1,
      lines: [wideRow],
      bufferTailEndIndex: 1,
    });

    mockClientWidth = 320;
    const adaptiveView = render(
      <div style={{ width: '320px', height: '408px' }}>
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
          widthMode="adaptive-phone"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    await waitFor(() => {
      const rows = readRenderedIndexedRows(adaptiveView.container);
      expect(rows[rows.length - 1]?.text).toBe(wideRow);
    });
    const adaptiveRow = adaptiveView.container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    const adaptiveCellWrap = adaptiveRow?.querySelector(':scope > span') as HTMLElement;
    expect(adaptiveRow.style.height).toBeTruthy();
    expect(adaptiveRow.style.height).not.toBe('auto');
    expect(adaptiveRow.style.minHeight).toBe('');
    expect(adaptiveCellWrap.style.width).toBe('');
    expect(adaptiveCellWrap.style.maxWidth).toBe('');
    expect(adaptiveCellWrap.style.whiteSpace).toBe('pre');
    adaptiveView.unmount();

    const fixedView = render(
      <div style={{ width: '320px', height: '408px' }}>
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
          widthMode="mirror-fixed"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    await waitFor(() => {
      const rows = readRenderedIndexedRows(fixedView.container);
      expect(rows[rows.length - 1]?.text).toBe(wideRow);
    });
    const fixedRow = fixedView.container.querySelector('[data-terminal-row="true"]') as HTMLElement;
    const fixedCellWrap = fixedRow?.querySelector(':scope > span') as HTMLElement;
    expect(fixedCellWrap.style.width).toBe('');
    expect(fixedCellWrap.style.whiteSpace).toBe('pre');
  });

  it('pans mirror-fixed content horizontally and restores the offset per session', async () => {
    const wideRow = '1234567890'.repeat(8);
    const session = makeSession({
      revision: 1,
      lines: [wideRow],
      bufferTailEndIndex: 1,
    });

    mockClientWidth = 320;
    const view = render(
      <div style={{ width: '320px', height: '408px' }}>
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
          widthMode="mirror-fixed"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    const scroller = view.container.querySelector('.wterm') as HTMLElement;
    const grid = view.container.querySelector('.term-grid') as HTMLElement;
    expect(grid.dataset.horizontalOffsetPx).toBe('0');

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 280, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 120, clientY: 124 }],
    });
    fireEvent.touchEnd(scroller);

    await waitFor(() => {
      expect(grid.dataset.horizontalOffsetPx).toBe('160');
      expect(grid.style.transform).toBe('translateX(-160px)');
    });
    expect(localStorage.getItem('zterm:terminal:mirror-fixed-horizontal-offsets')).toContain('"s1":160');

    view.unmount();
    const restored = render(
      <div style={{ width: '320px', height: '408px' }}>
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
          widthMode="mirror-fixed"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    await waitFor(() => {
      const restoredGrid = restored.container.querySelector('.term-grid') as HTMLElement;
      expect(restoredGrid.dataset.horizontalOffsetPx).toBe('160');
      expect(restoredGrid.style.transform).toBe('translateX(-160px)');
    });
  });

  it('keeps a rightward fixed-content pan from opening the drawer until the horizontal offset reaches zero', async () => {
    const wideRow = '1234567890'.repeat(8);
    const session = makeSession({
      revision: 1,
      lines: [wideRow],
      bufferTailEndIndex: 1,
    });
    const onSwipeTab = vi.fn();

    mockClientWidth = 320;
    const view = render(
      <div style={{ width: '320px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId={session.id}
          active
          enabled
          allowedStartEdge="left"
          allowedDirections="previous"
          onSwipeTab={onSwipeTab}
        >
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
            widthMode="mirror-fixed"
          />
        </TerminalTabSwipeSurface>
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    const scroller = view.container.querySelector('.wterm') as HTMLElement;
    const grid = view.container.querySelector('.term-grid') as HTMLElement;

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 280, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 120, clientY: 124 }],
    });
    fireEvent.touchEnd(scroller);

    await waitFor(() => {
      expect(grid.dataset.horizontalOffsetPx).toBe('160');
    });
    onSwipeTab.mockClear();

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 56, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 200, clientY: 124 }],
    });
    fireEvent.touchEnd(scroller);

    await waitFor(() => {
      expect(grid.dataset.horizontalOffsetPx).toBe('16');
    });
    expect(onSwipeTab).not.toHaveBeenCalled();

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 56, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 96, clientY: 124 }],
    });
    fireEvent.touchEnd(scroller);

    await waitFor(() => {
      expect(grid.dataset.horizontalOffsetPx).toBe('0');
    });
    expect(onSwipeTab).not.toHaveBeenCalled();

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 56, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 200, clientY: 124 }],
    });
    fireEvent.touchEnd(scroller);

    expect(onSwipeTab).toHaveBeenCalledTimes(1);
    expect(onSwipeTab).toHaveBeenCalledWith(session.id, 'previous');
  });

  it('keeps mirror-fixed positive-offset edge right pan out of the parent drawer gesture from touchstart', async () => {
    const wideRow = '1234567890'.repeat(8);
    const session = makeSession({
      revision: 1,
      lines: [wideRow],
      bufferTailEndIndex: 1,
    });
    const onParentTouchStart = vi.fn();
    const onParentTouchMove = vi.fn();
    const onParentTouchEnd = vi.fn();

    mockClientWidth = 320;
    const view = render(
      <div
        style={{ width: '320px', height: '408px' }}
        onTouchStart={onParentTouchStart}
        onTouchMove={onParentTouchMove}
        onTouchEnd={onParentTouchEnd}
      >
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
          widthMode="mirror-fixed"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    const scroller = view.container.querySelector('.wterm') as HTMLElement;
    const grid = view.container.querySelector('.term-grid') as HTMLElement;

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 280, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 120, clientY: 124 }],
      cancelable: true,
    });
    fireEvent.touchEnd(scroller, {
      changedTouches: [{ clientX: 120, clientY: 124 }],
    });

    await waitFor(() => {
      expect(grid.dataset.horizontalOffsetPx).toBe('160');
    });
    onParentTouchStart.mockClear();
    onParentTouchMove.mockClear();
    onParentTouchEnd.mockClear();

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 56, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 200, clientY: 124 }],
      cancelable: true,
    });
    fireEvent.touchEnd(scroller, {
      changedTouches: [{ clientX: 200, clientY: 124 }],
    });

    await waitFor(() => {
      expect(grid.dataset.horizontalOffsetPx).toBe('16');
    });
    expect(onParentTouchStart).not.toHaveBeenCalled();
    expect(onParentTouchMove).not.toHaveBeenCalled();
    expect(onParentTouchEnd).not.toHaveBeenCalled();
  });

  it('keeps mirror-fixed zero-offset non-edge right pan out of the parent drawer gesture', async () => {
    const wideRow = '1234567890'.repeat(8);
    const session = makeSession({
      revision: 1,
      lines: [wideRow],
      bufferTailEndIndex: 1,
    });
    const onParentTouchStart = vi.fn();
    const onParentTouchMove = vi.fn();
    const onParentTouchEnd = vi.fn();

    mockClientWidth = 320;
    const view = render(
      <div
        style={{ width: '320px', height: '408px' }}
        onTouchStart={onParentTouchStart}
        onTouchMove={onParentTouchMove}
        onTouchEnd={onParentTouchEnd}
      >
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
          widthMode="mirror-fixed"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    const scroller = view.container.querySelector('.wterm') as HTMLElement;
    const grid = view.container.querySelector('.term-grid') as HTMLElement;
    expect(grid.dataset.horizontalOffsetPx).toBe('0');

    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 180, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 260, clientY: 124 }],
      cancelable: true,
    });
    fireEvent.touchEnd(scroller, {
      changedTouches: [{ clientX: 260, clientY: 124 }],
    });

    expect(grid.dataset.horizontalOffsetPx).toBe('0');
    expect(onParentTouchStart).not.toHaveBeenCalled();
    expect(onParentTouchMove).not.toHaveBeenCalled();
    expect(onParentTouchEnd).not.toHaveBeenCalled();
  });

  it('does not pan adaptive-phone content horizontally', async () => {
    const wideRow = '1234567890'.repeat(8);
    const session = makeSession({
      revision: 1,
      lines: [wideRow],
      bufferTailEndIndex: 1,
    });

    mockClientWidth = 320;
    const view = render(
      <div style={{ width: '320px', height: '408px' }}>
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
          widthMode="adaptive-phone"
        />
      </div>,
    );

    act(() => {
      ResizeObserverMock.triggerAll();
    });

    const scroller = view.container.querySelector('.wterm') as HTMLElement;
    const grid = view.container.querySelector('.term-grid') as HTMLElement;
    fireEvent.touchStart(scroller, {
      touches: [{ clientX: 280, clientY: 120 }],
    });
    fireEvent.touchMove(scroller, {
      touches: [{ clientX: 120, clientY: 124 }],
    });
    fireEvent.touchEnd(scroller);

    expect(grid.dataset.horizontalOffsetPx).toBeUndefined();
    expect(grid.style.transform).toBe('');
    expect(localStorage.getItem('zterm:terminal:mirror-fixed-horizontal-offsets')).toBeNull();
  });

  it('only emits adaptive-phone upstream resize when width truth changes, not for pure height changes', async () => {
    vi.useFakeTimers();
    const onResize = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });

    render(
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
          onResize={onResize}
          onInput={vi.fn()}
          fontSize={5}
          widthMode="adaptive-phone"
        />
      </div>,
    );

    act(() => {
      vi.runAllTimers();
    });

    expect(onResize).toHaveBeenCalledTimes(1);
    const firstCall = onResize.mock.calls[0];
    expect(firstCall?.[1]).toBeGreaterThan(0);

    mockClientHeight = 520;
    act(() => {
      ResizeObserverMock.triggerAll();
      vi.runAllTimers();
    });

    expect(onResize).toHaveBeenCalledTimes(1);

    mockClientWidth = 320;
    act(() => {
      ResizeObserverMock.triggerAll();
      vi.runAllTimers();
    });

    expect(onResize).toHaveBeenCalledTimes(2);
    expect(onResize.mock.calls[1]?.[1]).not.toBe(firstCall?.[1]);
    vi.useRealTimers();
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
    scrollFromBottomIntoReading(scroller);

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

  it('keeps gap rows visible instead of replacing them with a loading strip while gap repair is in flight', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      startIndex: 20,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 100,
    });
    session.buffer.lines[8] = [];
    session.buffer.gapRanges = [{ startIndex: 28, endIndex: 29 }];

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
    scrollFromBottomIntoReading(scroller);

    await waitFor(() => {
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(true);
      expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
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
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
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
    scrollFromBottomIntoReading(scroller);

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

  it('repairs an overscrolled follow frame on refresh without waiting for a user touch event', async () => {
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
      let currentScrollTop = 0;
      let scrollHeight = 1360;
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
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('row-080');

      scrollHeight = 1206;
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

      expect(scroller.scrollTop).toBe(798);
      expect(readRenderedRows(view.container)).toContain('row-081');
    } finally {
      vi.useRealTimers();
    }
  });

  it('repairs scaled mirror-fixed blank frames and follow geometry changes during large refreshes', async () => {
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
            widthMode="mirror-fixed"
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
      const scaleLayer = view.container.querySelector('.term-render-scale-layer') as HTMLDivElement;
      let currentScrollTop = 0;
      let scrollHeight = 1360;
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
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('row-080');

      const zoom = '0.5';
      scaleLayer.style.zoom = zoom;
      scrollHeight = Math.round(1360 * Number(zoom));

      const nextSession = makeSession({
        revision: 2,
        lines: buildRows(120),
        bufferTailEndIndex: 120,
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
            widthMode="mirror-fixed"
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBeGreaterThan(0);
      expect(scroller.scrollTop).toBeLessThanOrEqual(Math.max(0, scrollHeight - 408));
      expect(readRenderedRows(view.container)).toContain('row-120');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-enter reading when a follow refresh temporarily leaves the DOM above bottom before realign', async () => {
    vi.useFakeTimers();
    try {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      onViewportChange.mockClear();

      scrollHeight = 1377;
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

      fireEvent.scroll(scroller);

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(969);
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-enter reading when follow only drifts one pixel above bottom during a live refresh', async () => {
    vi.useFakeTimers();
    try {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      onViewportChange.mockClear();

      scrollHeight = 1377;
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

      scroller.scrollTop = 951;
      fireEvent.scroll(scroller);

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(969);
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-enter reading when a live follow refresh temporarily drifts far above bottom before the follow realign runs', async () => {
    vi.useFakeTimers();
    try {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      onViewportChange.mockClear();

      scrollHeight = 1377;
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

      scroller.scrollTop = 880;
      fireEvent.scroll(scroller);

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(969);
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-enter reading when IME-style viewport shrink and live follow refresh fire a scroll before follow realign', async () => {
    vi.useFakeTimers();
    try {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      onViewportChange.mockClear();

      mockClientHeight = 272;
      scrollHeight = 1377;
      const nextSession = makeSession({
        revision: 2,
        lines: buildRows(81),
        bufferTailEndIndex: 81,
      });
      view.rerender(
        <div style={{ width: '640px', height: '272px' }}>
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

      await act(async () => {
        ResizeObserverMock.triggerAll();
        scroller.scrollTop = 760;
        fireEvent.scroll(scroller);
      });

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the authoritative tail rendered and publishes measured rows after the container shrinks', async () => {
    vi.useFakeTimers();
    try {
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
            onInput={vi.fn()}
            onViewportChange={onViewportChange}
            fontSize={5}
            showAbsoluteLineNumbers
          />
        </div>,
      );

      const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 80,
        viewportRows: 24,
      });

      onViewportChange.mockClear();
      mockClientHeight = 204;
      scrollHeight = 1360;
      act(() => {
        ResizeObserverMock.triggerAll();
      });
      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      const renderedRows = readRenderedIndexedRows(view.container);
      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows[renderedRows.length - 1]).toMatchObject({
        absoluteIndex: 79,
        text: 'row-080',
      });
      const renderedLineNumbers = readRenderedLineNumbers(view.container);
      expect(renderedLineNumbers[renderedLineNumbers.length - 1]).toBe(79);
      expect(view.container.querySelector('[data-terminal-line-discontinuous="true"]')).toBeNull();
      expect(onViewportChange).toHaveBeenLastCalledWith(session.id, {
        mode: 'follow',
        viewportEndIndex: 80,
        viewportRows: 12,
      });
      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps follow line numbers anchored to the latest tail during IME-style relayout and rapid tail refreshes', async () => {
    vi.useFakeTimers();
    try {
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
            showAbsoluteLineNumbers
          />
        </div>,
      );

      const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      onViewportChange.mockClear();
      mockClientHeight = 272;
      scrollHeight = 1377;

      const nextSession81 = makeSession({
        revision: 2,
        lines: buildRows(81),
        bufferTailEndIndex: 81,
      });
      view.rerender(
        <div style={{ width: '640px', height: '272px' }}>
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
            onViewportChange={onViewportChange}
            fontSize={5}
            showAbsoluteLineNumbers
          />
        </div>,
      );

      const nextSession82 = makeSession({
        revision: 3,
        lines: buildRows(82),
        bufferTailEndIndex: 82,
      });
      view.rerender(
        <div style={{ width: '640px', height: '272px' }}>
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
            onViewportChange={onViewportChange}
            fontSize={5}
            showAbsoluteLineNumbers
          />
        </div>,
      );

      await act(async () => {
        ResizeObserverMock.triggerAll();
        scroller.scrollTop = 760;
        fireEvent.scroll(scroller);
      });

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);

      const renderedLineNumbers = readRenderedLineNumbers(view.container);
      expect(renderedLineNumbers.length).toBeGreaterThan(0);
      expect(renderedLineNumbers[renderedLineNumbers.length - 1]).toBe(81);
      expect(view.container.querySelector('[data-terminal-line-discontinuous="true"]')).toBeNull();
      expect(readRenderedRows(view.container).some((row) => row.endsWith('row-082'))).toBe(true);
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

  it('keeps follow rows rendered when the user drags past the bottom in follow mode', async () => {
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
      expect(readRenderedRows(view.container)).toContain('row-080');
    });

    scroller.scrollTop = 980;
    fireEvent.scroll(scroller);

    await waitFor(() => {
      const rows = readRenderedRows(view.container);
      const lastCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1]?.[1];
      expect(lastCall?.mode).toBe('follow');
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toContain('row-080');
    });
  });



  it('keeps follow rows rendered during shell relayout without waiting for a later input reset', async () => {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('row-080');

      mockClientHeight = 340;
      scrollHeight = 1377;
      ResizeObserverMock.triggerAll();

      const rowsDuringRelayout = readRenderedRows(view.container);
      expect(rowsDuringRelayout.length).toBeGreaterThan(0);
      expect(rowsDuringRelayout).toContain('row-080');
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not auto-enter reading when follow refresh scroll events arrive without any recent user scroll intent', async () => {
    vi.useFakeTimers();
    try {
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
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('row-080');

      const nextSession = makeSession({
        revision: 2,
        lines: buildRows(81),
        bufferTailEndIndex: 81,
      });
      scrollHeight = 1377;

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

      scroller.scrollTop = 760;
      fireEvent.scroll(scroller);

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'reading')).toBe(false);
      const rows = readRenderedRows(view.container);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows).toContain('row-081');
    } finally {
      vi.useRealTimers();
    }
  });

  it('realigns follow scroll immediately when input reset and live tail refresh land together', async () => {
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
            inputResetEpoch={0}
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
      let scrollHeight = 1360;
      Object.defineProperty(scroller, 'scrollHeight', {
        configurable: true,
        get() {
          return scrollHeight;
        },
      });

      await act(async () => {
        vi.advanceTimersByTime(120);
      });

      expect(scroller.scrollTop).toBe(952);
      expect(readRenderedRows(view.container)).toContain('row-080');

      scrollHeight = 1377;
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
            inputResetEpoch={1}
            onResize={vi.fn()}
            onInput={vi.fn()}
            fontSize={5}
          />
        </div>,
      );

      expect(scroller.scrollTop).toBe(969);
      expect(readRenderedRows(view.container)).toContain('row-081');
      expect(view.container.querySelector('[data-terminal-history-loading="true"]')).toBeFalsy();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows absolute line number gutter only when debug overlay requests it', async () => {
    const session = makeSession({
      revision: 1,
      lines: ['alpha', 'beta', 'gamma'],
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
          showAbsoluteLineNumbers
        />
      </div>,
    );

    await waitFor(() => {
      const gutters = Array.from(view.container.querySelectorAll('[data-terminal-line-number="true"]'));
      expect(gutters.length).toBeGreaterThan(0);
      expect(gutters.some((node) => node.textContent?.trim() === '0')).toBe(true);
      expect(gutters.some((node) => node.textContent?.trim() === '2')).toBe(true);
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
          onResize={vi.fn()}
          onInput={vi.fn()}
          fontSize={5}
          showAbsoluteLineNumbers={false}
        />
      </div>,
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-terminal-line-number="true"]')).toBeNull();
    });
  });

  it('marks discontinuous absolute line numbers in red and renders gap rows as blank placeholders', async () => {
    const session = makeSession({
      revision: 1,
      lines: buildRows(80),
      bufferTailEndIndex: 80,
    });
    session.buffer.lines[70] = [];
    session.buffer.gapRanges = [{ startIndex: 70, endIndex: 71 }];

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
          showAbsoluteLineNumbers
        />
      </div>,
    );

    await waitFor(() => {
      expect(view.container.querySelector('[data-terminal-gap="true"]')).toBeTruthy();
    });

    const gapRow = view.container.querySelector('[data-terminal-gap="true"]') as HTMLDivElement;
    expect(gapRow).toBeTruthy();
    expect(gapRow.textContent?.replace(/\s+/gu, '')).toBe('70');

    const gapLineNumber = gapRow.querySelector('[data-terminal-line-number="true"]') as HTMLSpanElement;
    expect(gapLineNumber).toBeTruthy();
    expect(gapLineNumber.getAttribute('data-terminal-line-discontinuous')).toBe('true');
  });

  it('emits viewport updates for live panes even when they are not the interactive active pane', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 3,
      lines: buildRows(100),
      startIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 100,
    });

    render(
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
          active={false}
          live
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(onViewportChange).toHaveBeenCalled();
    });
    expect(onViewportChange.mock.calls.some(([, payload]) => payload?.mode === 'follow')).toBe(true);
  });

  it('reconciles live pane render state on buffer updates even when the pane is not the interactive active pane', async () => {
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
          live
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    let scrollHeight = 1360;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return scrollHeight;
      },
    });

    await waitFor(() => {
      expect(readRenderedRows(view.container)).toContain('row-080');
      expect(scroller.scrollTop).toBe(952);
    });

    onViewportChange.mockClear();

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(81),
      bufferTailEndIndex: 81,
    });
    scrollHeight = 1377;

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
          active={false}
          live
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    expect(readRenderedRows(view.container)).toContain('row-080');
    expect(readRenderedRows(view.container)).toContain('row-081');
    await waitFor(() => {
      expect(scroller.scrollTop).toBe(969);
      expect(onViewportChange).toHaveBeenCalled();
    });
  });

  it('keeps follow scroll aligned for a live non-interactive pane when render geometry changes', async () => {
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
          active={false}
          live
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    const scroller = view.container.querySelector('.wterm') as HTMLDivElement;
    let scrollHeight = 1360;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get() {
        return scrollHeight;
      },
    });

    await waitFor(() => {
      expect(readRenderedRows(view.container)).toContain('row-080');
    });

    const initialScrollTop = scroller.scrollTop;
    expect(initialScrollTop).toBe(952);

    const nextSession = makeSession({
      revision: 2,
      lines: buildRows(96),
      bufferTailEndIndex: 96,
    });
    scrollHeight = 1632;

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
          active={false}
          live
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      expect(readRenderedRows(view.container)).toContain('row-096');
    });
    expect(scroller.scrollTop).toBe(1224);
    expect(scroller.scrollTop).toBeGreaterThan(initialScrollTop);
  });


  it('emits at most one follow viewport update when a hidden terminal becomes active', async () => {
    const onViewportChange = vi.fn();
    const session = makeSession({
      revision: 3,
      lines: buildRows(100),
      startIndex: 0,
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
          active={false}
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    onViewportChange.mockClear();

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
          onResize={vi.fn()}
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => {
      const followCalls = onViewportChange.mock.calls
        .map(([, payload]) => payload)
        .filter((payload) => payload?.mode === 'follow');
      expect(followCalls.length).toBeLessThanOrEqual(1);
      expect(followCalls[0]).toMatchObject({
        mode: 'follow',
        viewportEndIndex: expect.any(Number),
        viewportRows: expect.any(Number),
      });
    });
  });
  it('each pane independently tracks scroll -- scrolling one pane does not move the other', async () => {
    const onInput = vi.fn();
    const sessionA = makeSession({ revision: 1, lines: buildRows(80), bufferTailEndIndex: 80 });
    const sessionB = makeSession({ revision: 1, lines: buildRows(80), bufferTailEndIndex: 80 });

    const { container: containerA } = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId={sessionA.id}
          initialBufferLines={sessionA.buffer.lines}
          bufferStartIndex={sessionA.buffer.startIndex}
          bufferEndIndex={sessionA.buffer.endIndex}
          bufferTailEndIndex={sessionA.buffer.bufferTailEndIndex}
          bufferGapRanges={sessionA.buffer.gapRanges}
          cursorKeysApp={sessionA.buffer.cursorKeysApp}
          active
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    const { container: containerB } = render(
      <div style={{ width: '320px', height: '204px' }}>
        <TerminalView
          sessionId={sessionB.id}
          initialBufferLines={sessionB.buffer.lines}
          bufferStartIndex={sessionB.buffer.startIndex}
          bufferEndIndex={sessionB.buffer.endIndex}
          bufferTailEndIndex={sessionB.buffer.bufferTailEndIndex}
          bufferGapRanges={sessionB.buffer.gapRanges}
          cursorKeysApp={sessionB.buffer.cursorKeysApp}
          active
          onInput={onInput}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(containerA)).toContain('row-080'));
    await waitFor(() => expect(readRenderedRows(containerB)).toContain('row-080'));

    // Pane A scrolls to middle -- user scroll, not programmatic
    const paneA = containerA.querySelector('.wterm') as HTMLDivElement;
    paneA.scrollTop = 300;
    fireEvent.scroll(paneA);

    // Pane B should still show bottom rows unchanged by pane A's scroll
    expect(readRenderedRows(containerB)).toContain('row-080');
    expect(readRenderedRows(containerB)).toContain('row-077');
  });

  it('resets follow viewport before paint when switching sessions on the same terminal surface', async () => {
    const sessionA = makeSession({ revision: 1, lines: buildRows(120, 'old'), bufferTailEndIndex: 120 });
    const sessionB = makeSession({ revision: 1, lines: buildRows(30, 'new'), bufferTailEndIndex: 30 });
    const onViewportChange = vi.fn();

    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="old-session"
          initialBufferLines={sessionA.buffer.lines}
          bufferStartIndex={sessionA.buffer.startIndex}
          bufferEndIndex={sessionA.buffer.endIndex}
          bufferTailEndIndex={sessionA.buffer.bufferTailEndIndex}
          bufferGapRanges={sessionA.buffer.gapRanges}
          cursorKeysApp={sessionA.buffer.cursorKeysApp}
          active
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('old-120'));
    scrollFromBottomIntoReading(view.container.querySelector('.wterm') as HTMLDivElement, 1632);
    expect(readRenderedRows(view.container)).toContain('old-001');

    view.rerender(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalView
          sessionId="new-session"
          initialBufferLines={sessionB.buffer.lines}
          bufferStartIndex={sessionB.buffer.startIndex}
          bufferEndIndex={sessionB.buffer.endIndex}
          bufferTailEndIndex={sessionB.buffer.bufferTailEndIndex}
          bufferGapRanges={sessionB.buffer.gapRanges}
          cursorKeysApp={sessionB.buffer.cursorKeysApp}
          active
          onInput={vi.fn()}
          onViewportChange={onViewportChange}
          fontSize={5}
        />
      </div>,
    );

    await waitFor(() => expect(readRenderedRows(view.container)).toContain('new-030'));
    expect(readRenderedRows(view.container)).not.toContain('new-001');
    const lastViewportCall = onViewportChange.mock.calls[onViewportChange.mock.calls.length - 1];
    expect(lastViewportCall?.[1]).toMatchObject({
      mode: 'follow',
      viewportEndIndex: 30,
    });
  });

  it('throttles split-visible resize observer bursts to one rAF after the 32ms gate', async () => {
    vi.useFakeTimers();
    const requestAnimationFrameSpy = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation(() => 1 as any);

    const session = makeSession({ revision: 1, lines: buildRows(24, 'split'), bufferTailEndIndex: 24 });

    render(
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
          splitVisible
          onInput={vi.fn()}
          fontSize={5}
        />
      </div>,
    );

    requestAnimationFrameSpy.mockClear();

    expect(requestAnimationFrameSpy).not.toHaveBeenCalled();

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
    vi.useRealTimers();
  });
});
