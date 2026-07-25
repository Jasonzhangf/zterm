// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createSessionRenderBufferStore } from '../../lib/session-render-buffer-store';
import type { Session, SessionRenderBufferSnapshot, TerminalCell } from '../../lib/types';
import { TerminalStageShell } from '../../pages/TerminalPageStageShell';
import { TerminalPreviewGrid } from './TerminalPreviewGrid';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  (globalThis as typeof globalThis & { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    ResizeObserverMock as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function row(text: string, options: Partial<TerminalCell> = {}): TerminalCell[] {
  return Array.from(text).map((char) => ({
    char: char.codePointAt(0) || 32,
    fg: 256,
    bg: 256,
    flags: 0,
    width: 1,
    ...options,
  }));
}

function snapshot(sessionIndex: number, revision: number, phase: string): SessionRenderBufferSnapshot {
  const marker = `S${sessionIndex}-${phase}-R${revision}`;
  const lines = [
    row(`${marker}-HEAD`, { fg: sessionIndex }),
    row(`${marker}-TUI`, { bg: sessionIndex + 8, flags: 4 }),
    row(`${marker}-INPUT`),
  ];
  return {
    lines,
    gapRanges: [],
    startIndex: revision * 10,
    endIndex: revision * 10 + lines.length,
    bufferHeadStartIndex: 0,
    bufferTailEndIndex: revision * 10 + lines.length,
    daemonHeadRevision: revision,
    daemonHeadEndIndex: revision * 10 + lines.length,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: { rowIndex: revision * 10 + 2, col: marker.length + 3, visible: true },
    revision,
  };
}

function renderedRows(tile: HTMLElement) {
  return Array.from(tile.querySelectorAll<HTMLElement>('[data-terminal-row="true"]'))
    .map((node) => node.dataset.terminalRowText || '');
}

const sessions = Array.from({ length: 6 }, (_, index) => ({
  id: `preview-session-${index + 1}`,
  title: `Preview ${index + 1}`,
  sessionName: `preview-${index + 1}`,
  state: 'connected',
  bridgeHost: '127.0.0.1',
  bridgePort: 3333,
})) as Session[];

describe('TerminalPreviewGrid render truth', () => {
  it('automatically keeps six preview DOM bodies equal to their own live render-store snapshots', async () => {
    const store = createSessionRenderBufferStore();
    for (let index = 0; index < sessions.length; index += 1) {
      store.setBuffer(sessions[index].id, snapshot(index + 1, 1, 'INITIAL'));
    }

    const view = render(
      <div style={{ width: '720px', height: '960px' }}>
        <TerminalPreviewGrid
          sessions={sessions}
          sessionBufferStore={store}
          landscape={false}
          fontSize={10}
          onActivateSession={() => undefined}
          onClose={() => undefined}
        />
      </div>,
    );

    for (let index = 0; index < sessions.length; index += 1) {
      const tile = view.getByTestId(`terminal-preview-tile-${sessions[index].id}`);
      expect(renderedRows(tile)).toEqual([
        `S${index + 1}-INITIAL-R1-HEAD`,
        `S${index + 1}-INITIAL-R1-TUI`,
        `S${index + 1}-INITIAL-R1-INPUT`,
      ]);
    }

    act(() => {
      for (let index = 0; index < sessions.length; index += 1) {
        store.setBuffer(sessions[index].id, snapshot(index + 1, 2, 'REFRESH'));
      }
    });

    await waitFor(() => {
      for (let index = 0; index < sessions.length; index += 1) {
        const tile = view.getByTestId(`terminal-preview-tile-${sessions[index].id}`);
        expect(renderedRows(tile)).toEqual([
          `S${index + 1}-REFRESH-R2-HEAD`,
          `S${index + 1}-REFRESH-R2-TUI`,
          `S${index + 1}-REFRESH-R2-INPUT`,
        ]);
        const terminal = tile.querySelector<HTMLElement>(`[data-terminal-session-id="${sessions[index].id}"]`);
        expect(terminal?.dataset.hasOninput).toBe('false');
        expect(terminal?.dataset.hasOnresize).toBe('false');
        expect(terminal?.dataset.widthMode).toBe('mirror-fixed');
      }
    });

    const allRows = sessions.flatMap((session) => renderedRows(view.getByTestId(`terminal-preview-tile-${session.id}`)));
    expect(new Set(allRows).size).toBe(18);
  });

  it('keeps child preview DOM refreshing after a body tap promotes another child to primary', async () => {
    const store = createSessionRenderBufferStore();
    const previewSessions = sessions.slice(0, 4);
    for (let index = 0; index < previewSessions.length; index += 1) {
      store.setBuffer(previewSessions[index].id, snapshot(index + 1, 1, 'INITIAL'));
    }
    const onActivateSession = vi.fn();

    const view = render(
      <div style={{ width: '720px', height: '960px' }}>
        <TerminalPreviewGrid
          sessions={previewSessions}
          sessionBufferStore={store}
          landscape={false}
          fontSize={10}
          onActivateSession={onActivateSession}
          onClose={() => undefined}
        />
      </div>,
    );

    fireEvent.click(view.getByTestId(`terminal-preview-body-${previewSessions[1].id}`));
    expect(onActivateSession).not.toHaveBeenCalled();
    expect(view.getByTestId(`terminal-preview-tile-${previewSessions[1].id}`).dataset.previewVariant).toBe('primary');

    act(() => {
      for (let index = 0; index < previewSessions.length; index += 1) {
        store.setBuffer(previewSessions[index].id, snapshot(index + 1, 2, 'REFRESH'));
      }
    });

    await waitFor(() => {
      for (let index = 0; index < previewSessions.length; index += 1) {
        const tile = view.getByTestId(`terminal-preview-tile-${previewSessions[index].id}`);
        expect(renderedRows(tile)).toEqual([
          `S${index + 1}-REFRESH-R2-HEAD`,
          `S${index + 1}-REFRESH-R2-TUI`,
          `S${index + 1}-REFRESH-R2-INPUT`,
        ]);
      }
    });
  });

  it('continues rendering the selected session after preview is replaced by the real shell', async () => {
    const store = createSessionRenderBufferStore();
    const target = sessions[1];
    store.setBuffer(sessions[0].id, snapshot(1, 1, 'PREVIEW'));
    store.setBuffer(target.id, snapshot(2, 1, 'PREVIEW'));
    const stableNoop = () => undefined;
    const stageProps = {
      renderedPaneSessions: [target],
      visiblePaneEntries: [],
      splitVisible: false,
      activePaneId: 'pane-main',
      terminalChromeBottomPx: 0,
      terminalKeyboardRequested: false,
      isAndroid: true,
      handleTerminalViewportChange: stableNoop,
      handleSwipeTab: stableNoop,
      handleActiveTerminalActivateInput: stableNoop,
      focusNonce: 0,
      terminalFontSize: 10,
      terminalThemeId: 'default',
      terminalWidthMode: 'mirror-fixed' as const,
      absoluteLineNumbersVisible: false,
      copySelection: {
        active: false,
        sessionId: null,
        startRowIndex: null,
        endRowIndex: null,
        menu: null,
      },
      onLongPressRow: stableNoop,
    };

    const view = render(
      <div style={{ width: '720px', height: '960px' }}>
        <TerminalStageShell
          {...stageProps}
          interactiveSession={sessions[0]}
          sessionBufferStore={store}
          sessionPreviewOpen
          sessionPreviewSessions={sessions.slice(0, 2)}
          onActivatePreviewSession={stableNoop}
          onCloseSessionPreview={stableNoop}
        />
      </div>,
    );

    expect(renderedRows(view.getByTestId(`terminal-preview-tile-${target.id}`))).toEqual([
      'S2-PREVIEW-R1-HEAD',
      'S2-PREVIEW-R1-TUI',
      'S2-PREVIEW-R1-INPUT',
    ]);

    view.rerender(
      <div style={{ width: '720px', height: '960px' }}>
        <TerminalStageShell
          {...stageProps}
          interactiveSession={target}
          sessionBufferStore={store}
          sessionPreviewOpen={false}
          sessionPreviewSessions={sessions.slice(0, 2)}
          onActivatePreviewSession={stableNoop}
          onCloseSessionPreview={stableNoop}
        />
      </div>,
    );

    act(() => {
      store.setBuffer(target.id, snapshot(2, 2, 'SHELL'));
    });

    await waitFor(() => {
      const shell = view.getByTestId('terminal-pane-shell');
      expect(renderedRows(shell)).toEqual([
        'S2-SHELL-R2-HEAD',
        'S2-SHELL-R2-TUI',
        'S2-SHELL-R2-INPUT',
      ]);
    });
  });
});
