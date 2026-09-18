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
  Reflect.deleteProperty(window, 'visualViewport');
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

function setVisualViewportHeight(height: number) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    value: { width: window.innerWidth, height },
  });
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

  it('collapses top and bottom strips to the layout plan while IME is visible', () => {
    setViewport(374, 706);
    setVisualViewportHeight(400);
    renderGrid();

    const top = screen.getByTestId('terminal-preview-tile-s2');
    const bottom = screen.getByTestId('terminal-preview-tile-s4');
    const focus = screen.getByTestId('terminal-preview-tile-s3');
    expect(top.style.height).toBe('0px');
    expect(bottom.style.height).toBe('0px');
    expect(bottom.style.top).toBe(`${706 - JUNCTION_PREVIEW_HEADER_HEIGHT_PX}px`);
    expect(focus.style.top).toBe(`${JUNCTION_PREVIEW_GAP_PX}px`);
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

  it('uses the rendered preview container height instead of the full viewport for bottom-edge geometry', () => {
    setViewport(1707, 960);
    const rect = {
      x: 0,
      y: 0,
      width: 1699,
      height: 688,
      top: 0,
      right: 1699,
      bottom: 688,
      left: 0,
      toJSON: () => ({}),
    };
    const resizeObservers: Array<() => void> = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserverMock {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeObservers.push(() => this.callback([], this as unknown as ResizeObserver));
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    render(
      <div style={{ width: '1699px', height: '724px' }}>
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
        />
      </div>,
    );

    const grid = screen.getByTestId('terminal-preview-grid');
    const bottom = screen.getByTestId('terminal-preview-tile-s4');
    const content = grid.lastElementChild as HTMLElement;
    content.getBoundingClientRect = () => rect as DOMRect;
    act(() => {
      for (const trigger of resizeObservers) trigger();
    });
    globalThis.ResizeObserver = originalResizeObserver;

    expect(grid.dataset.layoutForm).toBe('wide');
    expect(bottom.style.top).toBe(`${688 - JUNCTION_PREVIEW_EDGE_PX.topBottom}px`);
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

  it('shows the full visible drawer catalog in the slot menu, including unopened sessions', () => {
    setViewport(374, 706);
    const unopenedId = 'remote:mac::session:unopened';
    renderGrid({
      lattice: latticeFor([{ col: 0, row: 0, session: sessions[2] }]),
      candidates: sessions.slice(0, 3),
      slotMenuCandidates: [
        ...sessions.slice(0, 3).map((session) => ({
          id: session.id,
          stableKey: session.id,
          title: session.title,
          subtitle: session.sessionName,
          sessionName: session.sessionName,
          hostKey: 'mac.local:3333',
          hostLabel: 'mac.local',
        })),
        {
          id: unopenedId,
          stableKey: unopenedId,
          title: 'Unopened Session',
          subtitle: 'mac.local · unopened',
          sessionName: 'unopened',
          hostKey: 'mac.local:3333',
          hostLabel: 'mac.local',
        },
      ],
    });

    fireEvent.click(screen.getByTestId('terminal-preview-empty--1-0'));

    expect(screen.getByTestId('terminal-preview-assign-s1')).toBeTruthy();
    expect(screen.getByTestId(`terminal-preview-assign-${unopenedId}`)).toBeTruthy();
  });

  it('pinches to overview scale, pans locally, and restores to 1x with cleared pan', () => {
    setViewport(374, 706);
    renderGrid();

    const grid = screen.getByTestId('terminal-preview-grid');
    const scaler = screen.getByTestId('terminal-preview-scaler');
    expect(scaler.dataset.previewScale).toBe('1');

    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 125, clientY: 220 },
        { clientX: 175, clientY: 220 },
      ],
    });
    expect(Number(scaler.dataset.previewScale)).toBeLessThan(1);
    expect(Number(scaler.dataset.previewPanX)).toBe(0);
    expect(Number(scaler.dataset.previewPanY)).toBe(0);

    fireEvent.touchEnd(grid, {
      changedTouches: [
        { clientX: 125, clientY: 220 },
        { clientX: 175, clientY: 220 },
      ],
    });
    fireEvent.touchStart(grid, { touches: [{ clientX: 160, clientY: 260 }] });
    fireEvent.touchMove(grid, { touches: [{ clientX: 190, clientY: 280 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 190, clientY: 280 }] });

    expect(Number(scaler.dataset.previewPanX)).toBeGreaterThan(0);
    expect(Number(scaler.dataset.previewPanY)).toBeGreaterThan(0);

    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 120, clientY: 220 },
        { clientX: 180, clientY: 220 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 90, clientY: 200 },
        { clientX: 210, clientY: 200 },
      ],
    });
    fireEvent.touchEnd(grid, {
      changedTouches: [
        { clientX: 90, clientY: 200 },
        { clientX: 210, clientY: 200 },
      ],
    });

    expect(scaler.dataset.previewScale).toBe('1');
    expect(scaler.dataset.previewPanX).toBe('0');
    expect(scaler.dataset.previewPanY).toBe('0');
  });

  it('renders the whole lattice in overview and lets a distant tile become focus', () => {
    setViewport(374, 706);
    const onFocusChange = vi.fn();
    renderGrid({
      lattice: latticeFor([
        { col: 0, row: 0, session: sessions[2] },
        { col: 4, row: 0, session: sessions[7] },
      ]),
      onFocusChange,
    });

    expect(screen.queryByTestId('terminal-preview-tile-s8')).toBeNull();
    const grid = screen.getByTestId('terminal-preview-grid');
    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 125, clientY: 220 },
        { clientX: 175, clientY: 220 },
      ],
    });
    fireEvent.touchEnd(grid, {
      changedTouches: [
        { clientX: 125, clientY: 220 },
        { clientX: 175, clientY: 220 },
      ],
    });

    const distantTile = screen.getByTestId('terminal-preview-tile-s8');
    expect(distantTile.dataset.previewFocus).toBe('false');
    expect(Number.parseFloat(distantTile.style.width)).toBeGreaterThan(100);
    fireEvent.touchStart(distantTile, { touches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.touchEnd(distantTile, { changedTouches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.click(distantTile);
    expect(onFocusChange).toHaveBeenCalledWith({ col: 4, row: 0 });
  });

  it('reports the full populated lattice to the live projection while overview is active', () => {
    setViewport(374, 706);
    const onOverviewChange = vi.fn();
    renderGrid({
      lattice: latticeFor([
        { col: 0, row: 0, session: sessions[2] },
        { col: 4, row: 0, session: sessions[7] },
      ]),
      onOverviewChange,
    });

    const grid = screen.getByTestId('terminal-preview-grid');
    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 125, clientY: 200 },
        { clientX: 175, clientY: 200 },
      ],
    });

    expect(onOverviewChange).toHaveBeenLastCalledWith([
      { col: 0, row: 0 },
      { col: 4, row: 0 },
    ]);
  });

  it('scales the overview projection without changing the renderer pane dimensions', () => {
    setViewport(374, 706);
    renderGrid();

    const focusTile = screen.getByTestId('terminal-preview-tile-s3');
    const focusBody = screen.getByTestId('terminal-preview-body-s3');
    const focusWidth = focusTile.style.width;
    const focusHeight = focusTile.style.height;
    const bodyWidth = focusBody.style.width;
    const bodyHeight = focusBody.style.height;

    const grid = screen.getByTestId('terminal-preview-grid');
    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 125, clientY: 200 },
        { clientX: 175, clientY: 200 },
      ],
    });

    const overviewFocusTile = screen.getByTestId('terminal-preview-tile-s3');
    const overviewFocusBody = screen.getByTestId('terminal-preview-body-s3');
    expect(overviewFocusTile.style.width).toBe(focusWidth);
    expect(overviewFocusTile.style.height).toBe(focusHeight);
    expect(overviewFocusBody.style.width).toBe(bodyWidth);
    expect(overviewFocusBody.style.height).toBe(bodyHeight);
  });

  it('fits and centers the overview projection inside the preview viewport', () => {
    setViewport(374, 706);
    renderGrid();

    const grid = screen.getByTestId('terminal-preview-grid');
    const content = grid.lastElementChild as HTMLElement;
    const contentRect = {
      x: 0,
      y: 0,
      width: 374,
      height: 706 - JUNCTION_PREVIEW_HEADER_HEIGHT_PX,
      top: 0,
      right: 374,
      bottom: 706 - JUNCTION_PREVIEW_HEADER_HEIGHT_PX,
      left: 0,
      toJSON: () => ({}),
    };
    const resizeObservers: Array<() => void> = [];
    const originalResizeObserver = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class ResizeObserverMock {
      private readonly callback: ResizeObserverCallback;

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        resizeObservers.push(() => this.callback([], this as unknown as ResizeObserver));
      }

      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    content.getBoundingClientRect = () => contentRect as DOMRect;
    act(() => {
      for (const trigger of resizeObservers) trigger();
    });
    globalThis.ResizeObserver = originalResizeObserver;

    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 125, clientY: 200 },
        { clientX: 175, clientY: 200 },
      ],
    });

    const scaler = screen.getByTestId('terminal-preview-scaler');
    const fitScale = Number(scaler.dataset.previewEffectiveScale);
    const contentWidth = Number(scaler.dataset.previewContentWidth);
    const contentHeight = Number(scaler.dataset.previewContentHeight);
    const translateX = Number(scaler.dataset.previewTranslateX);
    const translateY = Number(scaler.dataset.previewTranslateY);

    expect(fitScale).toBeGreaterThan(0);
    expect(fitScale).toBeLessThanOrEqual(1);
    expect(translateX).toBeGreaterThanOrEqual(0);
    expect(translateY).toBeGreaterThanOrEqual(0);
    expect(translateX + contentWidth * fitScale).toBeLessThanOrEqual(contentRect.width);
    expect(translateY + contentHeight * fitScale).toBeLessThanOrEqual(contentRect.height);
    expect(translateX).toBeCloseTo((contentRect.width - contentWidth * fitScale) / 2, 5);
    expect(translateY).toBeCloseTo((contentRect.height - contentHeight * fitScale) / 2, 5);
  });

  it('allows an empty-cell tap immediately after a pinch gesture', () => {
    setViewport(374, 706);
    renderGrid({
      lattice: latticeFor([{ col: 0, row: 0, session: sessions[2] }]),
    });

    const grid = screen.getByTestId('terminal-preview-grid');
    fireEvent.touchStart(grid, {
      touches: [
        { clientX: 100, clientY: 200 },
        { clientX: 200, clientY: 200 },
      ],
    });
    fireEvent.touchMove(grid, {
      touches: [
        { clientX: 125, clientY: 200 },
        { clientX: 175, clientY: 200 },
      ],
    });
    fireEvent.touchEnd(grid, {
      changedTouches: [
        { clientX: 125, clientY: 200 },
        { clientX: 175, clientY: 200 },
      ],
    });

    fireEvent.touchStart(grid, { touches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.touchEnd(grid, { changedTouches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.click(screen.getByTestId('terminal-preview-empty--1-0'));

    expect(screen.getByTestId('terminal-preview-slot-menu')).toBeTruthy();
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

  it('keeps the clear action when the assigned session is absent from the drawer catalog', () => {
    vi.useFakeTimers();
    setViewport(374, 706);
    const onClearCell = vi.fn();
    renderGrid({
      onClearCell,
      slotMenuCandidates: sessions.slice(1).map((session) => ({
        id: session.id,
        stableKey: session.id,
        title: session.title,
        subtitle: session.sessionName,
        sessionName: session.sessionName,
        hostKey: 'mac.local:3333',
        hostLabel: 'mac.local',
      })),
    });

    fireEvent.pointerDown(screen.getByTestId('terminal-preview-tile-s1'), { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    fireEvent.click(screen.getByTestId('terminal-preview-clear--1-0'));

    expect(onClearCell).toHaveBeenCalledWith({ col: -1, row: 0 });
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

  it('does not suppress a later click on a different edge cell after long-press', () => {
    vi.useFakeTimers();
    setViewport(1280, 720);
    const onFocusChange = vi.fn();
    renderGrid({ onFocusChange });

    fireEvent.pointerDown(screen.getByTestId('terminal-preview-tile-s1'), { clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(450);
    });
    fireEvent.click(screen.getByTestId('terminal-preview-tile-s5'));

    expect(onFocusChange).toHaveBeenCalledWith({ col: 1, row: 0 });
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
