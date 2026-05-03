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
        savedTabLists={[]}
        onClose={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onMoveSession={onMoveSession}
        onOpenQuickTabPicker={vi.fn()}
        onSaveCurrentTabList={vi.fn()}
        onLoadSavedTabList={vi.fn()}
        onDeleteSavedTabList={vi.fn()}
        onExportCurrentTabList={vi.fn(() => '')}
        onExportSavedTabList={vi.fn(() => '')}
        onImportSavedTabLists={vi.fn(() => ({ ok: true, message: 'ok' }))}
      />,
    );

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
        savedTabLists={[]}
        onClose={vi.fn()}
        onSwitchSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={onCloseSession}
        onMoveSession={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onSaveCurrentTabList={vi.fn()}
        onLoadSavedTabList={vi.fn()}
        onDeleteSavedTabList={vi.fn()}
        onExportCurrentTabList={vi.fn(() => '')}
        onExportSavedTabList={vi.fn(() => '')}
        onImportSavedTabLists={vi.fn(() => ({ ok: true, message: 'ok' }))}
      />,
    );

    const closeButton = screen.getByRole('button', { name: '关闭 tab-1' });
    fireEvent.pointerUp(closeButton, { pointerId: 7 });
    expect(onCloseSession).toHaveBeenCalledWith('s1', 'tab-manager-close-button');
  });
});
