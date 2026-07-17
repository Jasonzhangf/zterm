// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabManagerSheet, type TabManagerSessionItem } from './TabManagerSheet';
import type { Session } from '../../lib/types';

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function buildSession(id: string, sessionName: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: sessionName,
    sessionName,
    bridgeHost: '100.64.0.1',
    bridgePort: 3333,
    state: 'connected',
    title: sessionName,
    ws: null,
    hasUnread: false,
    createdAt: Date.now(),
    buffer: {
      revision: 0,
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      lines: [],
      gapRanges: [],
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
    },
  };
}


function toTabManagerSession(session: Session): TabManagerSessionItem {
  return {
    id: session.id,
    bridgeHost: session.bridgeHost,
    bridgePort: session.bridgePort,
    sessionName: session.sessionName,
    customName: session.customName,
    resolvedPath: session.resolvedPath,
    resolvedRelayTransport: session.resolvedRelayTransport,
  };
}
describe('TabManagerSheet', () => {
  beforeEach(() => {
    cleanup();
    vi.useFakeTimers();
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('commits tab reorder after long-press drag handle move', () => {
    const onMoveSession = vi.fn();
    render(
      <TabManagerSheet
        open
        sessions={[
          toTabManagerSession(buildSession('s1', 'tab-1')),
          toTabManagerSession(buildSession('s2', 'tab-2')),
          toTabManagerSession(buildSession('s3', 'tab-3')),
        ]}
        activeSessionId="s1"
        onClose={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onMoveSession={onMoveSession}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.queryByText('Save Current')).toBeNull();
    expect(screen.queryByText('Saved Tab Lists')).toBeNull();

    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-tab-list-row="true"]'));
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () =>
        ({
          top: index * 60,
          bottom: index * 60 + 48,
          left: 0,
          right: 320,
          width: 320,
          height: 48,
          x: 0,
          y: index * 60,
          toJSON: () => ({}),
        }) as DOMRect;
    });

    const handle = screen.getByRole('button', { name: 'Sort tab-1' });
    fireEvent.pointerDown(handle, { pointerId: 1, clientY: 24 });
    act(() => {
      vi.advanceTimersByTime(361);
    });
    fireEvent.pointerMove(handle, { pointerId: 1, clientY: 170 });
    fireEvent.pointerUp(handle, { pointerId: 1, clientY: 170 });

    expect(onMoveSession).toHaveBeenCalledWith('s1', 2);
  });

  it('closes a tab from pointer events used by touch devices', () => {
    const onCloseSession = vi.fn();
    render(
      <TabManagerSheet
        open
        sessions={[
          toTabManagerSession(buildSession('s1', 'tab-1')),
          toTabManagerSession(buildSession('s2', 'tab-2')),
        ]}
        activeSessionId="s1"
        onClose={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
        onMoveSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    const closeButton = screen.getByRole('button', { name: '关闭 tab-1' });
    fireEvent.pointerUp(closeButton, { pointerId: 7 });
    expect(onCloseSession).toHaveBeenCalledWith('s1', 'tab-manager-close-button');
  });

  it('shows Relay TURN when a session route resolves through TURN', () => {
    const session = buildSession('s1', 'tab-1');
    session.resolvedPath = 'rtc-relay';
    session.resolvedRelayTransport = 'turn';

    render(
      <TabManagerSheet
        open
        sessions={[toTabManagerSession(session)]}
        activeSessionId="s1"
        onClose={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onMoveSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
      />,
    );

    expect(screen.getByText(/Relay TURN/)).toBeTruthy();
  });
});
