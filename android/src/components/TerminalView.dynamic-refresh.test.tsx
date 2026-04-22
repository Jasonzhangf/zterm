// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalView } from './TerminalView';
import { createSessionBufferState } from '../lib/terminal-buffer';
import type { Session } from '../lib/types';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

function buildRows(count: number, prefix = 'row') {
  return Array.from({ length: count }, (_, index) => `${prefix}-${String(index + 1).padStart(3, '0')}`);
}

function makeSession(options: {
  revision: number;
  lines: string[];
  viewportEndIndex: number;
}) {
  const buffer = createSessionBufferState({
    lines: options.lines,
    startIndex: 0,
    endIndex: options.lines.length,
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

  beforeEach(() => {
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
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
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
    expect(readRenderedRows(view.container)).not.toContain('row-056');
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
          bufferViewportEndIndex={session.buffer.viewportEndIndex}
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

    expect(onInput).toHaveBeenCalledWith('typed-from-client');
    expect(readRenderedRows(view.container)).toContain('stable-line-001');
    expect(readRenderedRows(view.container)).not.toContain('typed-from-client');
  });
});
