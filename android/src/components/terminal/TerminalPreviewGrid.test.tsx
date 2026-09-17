// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  JUNCTION_PREVIEW_EDGE_PX,
  JUNCTION_PREVIEW_GAP_PX,
  JUNCTION_PREVIEW_HEADER_HEIGHT_PX,
} from '../../lib/junction-preview-layout';
import type { Session } from '../../lib/types';
import type { JunctionPreviewLatticeV1 } from '../../lib/junction-preview-lattice';

const terminalViewSpy = vi.hoisted(() => vi.fn());
vi.mock('../TerminalView', () => ({
  TerminalView: (props: unknown) => {
    terminalViewSpy(props);
    const sessionId = (props as { sessionId: string }).sessionId;
    return <div data-testid={`preview-terminal-body-${sessionId}`}>{sessionId}-body</div>;
  },
}));

import { TerminalPreviewGrid } from './TerminalPreviewGrid';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  terminalViewSpy.mockClear();
});

const sessions = Array.from({ length: 8 }, (_, index) => ({
  id: `s${index + 1}`,
  title: `Session ${index + 1}`,
  sessionName: `tmux-${index + 1}`,
  state: 'connected',
  bridgeHost: 'mac.local',
  bridgePort: 3333,
})) as Session[];

function latticeFor(coordinates: Array<{ col: number; row: number; session: Session }>): JunctionPreviewLatticeV1 {
  return {
    version: 1,
    cells: coordinates.map(({ col, row, session }) => ({
      col,
      row,
      target: {
        sessionId: session.id,
        daemonHostId: session.daemonHostId,
        bridgeHost: session.bridgeHost,
        bridgePort: session.bridgePort,
        sessionName: session.sessionName,
      },
    })),
  };
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
}

function renderGrid(overrides: Partial<Parameters<typeof TerminalPreviewGrid>[0]> = {}) {
  return render(
    <TerminalPreviewGrid
      lattice={latticeFor([
        { col: -1, row: 0, session: sessions[0] },
        { col: 0, row: -1, session: sessions[1] },
        { col: 0, row: 0, session: sessions[2] },
        { col: 0, row: 1, session: sessions[3] },
        { col: 1, row: 0, session: sessions[4] },
      ])}
      focus={{ col: 0, row: 0 }}
      candidates={sessions}
      sessionBufferStore={null}
      fontSize={10}
      onFocusChange={vi.fn()}
      onSetCell={vi.fn()}
      onClearCell={vi.fn()}
      onClose={vi.fn()}
      {...overrides}
    />,
  );
}

describe('TerminalPreviewGrid', () => {
  it('projects portrait phone as focus plus one side strip and two horizontal strips', () => {
    setViewport(374, 706);
    renderGrid();

    const grid = screen.getByTestId('terminal-preview-grid');
    expect(grid.dataset.layoutForm).toBe('portrait');
    expect(screen.getByTestId('terminal-preview-tile-s1').dataset.previewEdge).toBe('left');
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewEdge).toBe('top');
    expect(screen.getByTestId('terminal-preview-tile-s3').dataset.previewEdge).toBe('focus');
    expect(screen.getByTestId('terminal-preview-tile-s4').dataset.previewEdge).toBe('bottom');
    expect(screen.queryByTestId('terminal-preview-tile-s5')).toBeNull();
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(4);
  });

  it('projects landscape phone as two center panes plus top and bottom strips', () => {
    setViewport(800, 500);
    renderGrid();

    const grid = screen.getByTestId('terminal-preview-grid');
    const focusWidth = (800 - JUNCTION_PREVIEW_GAP_PX) / 2;
    const top = screen.getByTestId('terminal-preview-tile-s2');
    const bottom = screen.getByTestId('terminal-preview-tile-s4');
    expect(grid.dataset.layoutForm).toBe('landscape');
    expect(screen.getByTestId('terminal-preview-tile-s1').dataset.previewEdge).toBe('focus');
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewEdge).toBe('top');
    expect(screen.getByTestId('terminal-preview-tile-s3').dataset.previewEdge).toBe('focus');
    expect(screen.getByTestId('terminal-preview-tile-s4').dataset.previewEdge).toBe('bottom');
    expect(top.style.left).toBe(`${focusWidth + JUNCTION_PREVIEW_GAP_PX}px`);
    expect(top.style.top).toBe('0px');
    expect(top.style.width).toBe(`${focusWidth}px`);
    expect(top.style.height).toBe(`${JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
    expect(bottom.style.left).toBe(`${focusWidth + JUNCTION_PREVIEW_GAP_PX}px`);
    expect(bottom.style.top).toBe(`${500 - JUNCTION_PREVIEW_HEADER_HEIGHT_PX - JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
    expect(bottom.style.width).toBe(`${focusWidth}px`);
    expect(bottom.style.height).toBe(`${JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(4);
  });

  it('projects wide viewport as focus plus left, right, top, and bottom strips', () => {
    setViewport(1280, 720);
    renderGrid();

    const grid = screen.getByTestId('terminal-preview-grid');
    const focusWidth = 1280 - JUNCTION_PREVIEW_EDGE_PX.side * 2 - JUNCTION_PREVIEW_GAP_PX * 2;
    const focusLeft = JUNCTION_PREVIEW_EDGE_PX.side + JUNCTION_PREVIEW_GAP_PX;
    const top = screen.getByTestId('terminal-preview-tile-s2');
    const bottom = screen.getByTestId('terminal-preview-tile-s4');
    expect(grid.dataset.layoutForm).toBe('wide');
    expect(screen.getByTestId('terminal-preview-tile-s1').dataset.previewEdge).toBe('left');
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewEdge).toBe('top');
    expect(screen.getByTestId('terminal-preview-tile-s3').dataset.previewEdge).toBe('focus');
    expect(screen.getByTestId('terminal-preview-tile-s5').dataset.previewEdge).toBe('right');
    expect(screen.getByTestId('terminal-preview-tile-s4').dataset.previewEdge).toBe('bottom');
    expect(top.style.left).toBe(`${focusLeft}px`);
    expect(top.style.top).toBe('0px');
    expect(top.style.width).toBe(`${focusWidth}px`);
    expect(top.style.height).toBe(`${JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
    expect(bottom.style.left).toBe(`${focusLeft}px`);
    expect(bottom.style.top).toBe(`${720 - JUNCTION_PREVIEW_HEADER_HEIGHT_PX - JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
    expect(bottom.style.width).toBe(`${focusWidth}px`);
    expect(bottom.style.height).toBe(`${JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(5);
  });

  it('pans focus to an edge cell without changing lattice ownership', () => {
    setViewport(374, 706);
    const onFocusChange = vi.fn();
    const onSetCell = vi.fn();
    const lattice = latticeFor([
      { col: -1, row: 0, session: sessions[0] },
      { col: 0, row: 0, session: sessions[2] },
    ]);
    renderGrid({ lattice, onFocusChange, onSetCell });

    fireEvent.click(screen.getByTestId('terminal-preview-tile-s1'));
    expect(onFocusChange).toHaveBeenCalledWith({ col: -1, row: 0 });
    expect(onSetCell).not.toHaveBeenCalled();
  });

  it('renders empty and stale cells as plus and assigns a session through the slot menu', () => {
    setViewport(374, 706);
    const onSetCell = vi.fn();
    renderGrid({
      lattice: latticeFor([{ col: 0, row: 0, session: sessions[2] }]),
      onSetCell,
    });

    expect(screen.getByTestId('terminal-preview-empty--1-0')).toBeTruthy();
    fireEvent.click(screen.getByTestId('terminal-preview-empty--1-0'));
    fireEvent.click(screen.getByTestId('terminal-preview-assign-s1'));
    expect(onSetCell).toHaveBeenCalledWith({ col: -1, row: 0 }, 's1');
  });

  it('long-presses an edge cell to clear its assignment without panning focus', () => {
    vi.useFakeTimers();
    setViewport(374, 706);
    const onClearCell = vi.fn();
    const onFocusChange = vi.fn();
    renderGrid({ onClearCell, onFocusChange });

    fireEvent.pointerDown(screen.getByTestId('terminal-preview-tile-s1'), { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    fireEvent.click(screen.getByTestId('terminal-preview-clear--1-0'));

    expect(onClearCell).toHaveBeenCalledWith({ col: -1, row: 0 });
    expect(onFocusChange).not.toHaveBeenCalled();
  });

  it('suppresses the click emitted after a long-press menu opens', () => {
    vi.useFakeTimers();
    setViewport(374, 706);
    const onFocusChange = vi.fn();
    const onClearCell = vi.fn();
    renderGrid({ onFocusChange, onClearCell });

    const tile = screen.getByTestId('terminal-preview-tile-s1');
    fireEvent.pointerDown(tile, { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    fireEvent.pointerUp(tile, { clientX: 10, clientY: 10 });
    fireEvent.click(tile);

    expect(onFocusChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('terminal-preview-clear--1-0'));
    expect(onClearCell).toHaveBeenCalledTimes(1);
  });

  it('exits on a horizontal right swipe but not a vertical gesture', () => {
    setViewport(374, 706);
    const onClose = vi.fn();
    renderGrid({ onClose });
    const grid = screen.getByTestId('terminal-preview-grid');

    fireEvent.touchStart(grid, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 160, clientY: 204 }] });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.touchStart(grid, { touches: [{ clientX: 80, clientY: 200 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 84, clientY: 280 }] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mounts a read-only mirror-fixed renderer only for visible populated cells', () => {
    setViewport(374, 706);
    renderGrid();

    const calls = terminalViewSpy.mock.calls.map(([props]) => props as Record<string, unknown>);
    expect(calls).toHaveLength(4);
    expect(calls.every((props) => props.active === false)).toBe(true);
    expect(calls.every((props) => props.widthMode === 'mirror-fixed')).toBe(true);
    expect(calls.every((props) => props.onInput === undefined)).toBe(true);
    expect(calls.every((props) => props.onResize === undefined)).toBe(true);
    expect(terminalViewSpy.mock.calls.some(([props]) => (props as { sessionId: string }).sessionId === 's5')).toBe(false);
  });
});
