// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../lib/types';

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

const sessions = Array.from({ length: 6 }, (_, index) => ({
  id: `s${index + 1}`,
  title: `Session ${index + 1}`,
  sessionName: `tmux-${index + 1}`,
  state: 'connected',
  bridgeHost: 'mac.local',
  bridgePort: 3333,
})) as Session[];

describe('TerminalPreviewGrid', () => {
  it.each([
    [false, 1, 'row', 'row'],
    [false, 4, 'column', 'row'],
    [true, 4, 'row', 'column'],
  ])('derives grouped %s orientation layout for %i selected sessions', (landscape, count, primaryAxis, secondaryAxis) => {
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, count)}
        sessionBufferStore={null}
        landscape={landscape}
        fontSize={10}
        onActivateSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const grid = screen.getByTestId('terminal-preview-grid');
    expect(grid.dataset.windowGroupPrimaryAxis).toBe(primaryAxis);
    expect(grid.dataset.windowGroupSecondaryAxis).toBe(secondaryAxis);
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(count);
  });

  it('renders six ordered read-only terminals in a primary-plus-children layout', () => {
    const onActivateSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        themeId="default"
        onActivateSession={onActivateSession}
        onClose={vi.fn()}
      />,
    );

    const grid = screen.getByTestId('terminal-preview-grid');
    expect(grid.dataset.windowGroupPrimaryAxis).toBe('column');
    expect(grid.dataset.windowGroupSecondaryAxis).toBe('row');
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(6);
    expect(terminalViewSpy).toHaveBeenCalledTimes(6);
    const terminalProps = terminalViewSpy.mock.calls.map(([props]) => props as Record<string, unknown>);
    expect(terminalProps[0]).toMatchObject({ active: false, live: true, projectionMode: 'preview-primary', splitVisible: true });
    for (const props of terminalProps.slice(1)) {
      expect(props).toMatchObject({ active: false, live: true, projectionMode: 'preview-secondary', splitVisible: true });
      expect((props as Record<string, unknown>).onInput).toBeUndefined();
      expect((props as Record<string, unknown>).onResize).toBeUndefined();
      expect((props as Record<string, unknown>).onViewportChange).toBeUndefined();
    }

    fireEvent.click(screen.getByTestId('terminal-preview-tile-s1'));
    expect(onActivateSession).toHaveBeenCalledWith('s1');
  });

  it('uses landscape side-rail layout and exposes close command', () => {
    const onClose = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 2)}
        sessionBufferStore={null}
        landscape
        fontSize={10}
        themeId="default"
        onActivateSession={vi.fn()}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId('terminal-preview-grid').dataset.windowGroupPrimaryAxis).toBe('row');
    expect(screen.getByTestId('terminal-preview-secondary-s2').getAttribute('style') || '').toContain('flex');
    fireEvent.click(screen.getByLabelText('退出终端预览'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking a child preview promotes it to the large primary preview without activating', () => {
    const onActivateSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-preview-tile-s1').dataset.previewVariant).toBe('primary');
    fireEvent.click(screen.getByTestId('terminal-preview-secondary-s2'));
    expect(onActivateSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewVariant).toBe('primary');
  });

  it('keeps one layout and no quick peek when selecting a child', () => {
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId('terminal-preview-body-s2'));

    expect(screen.getAllByTestId('terminal-preview-grid')).toHaveLength(1);
    expect(screen.queryByTestId('terminal-preview-quick-peek')).toBeNull();
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(3);
  });

  it('clicking inside a child preview body promotes it without activating', () => {
    const onActivateSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByTestId('terminal-preview-tile-s1').dataset.previewVariant).toBe('primary');
    fireEvent.click(screen.getByTestId('terminal-preview-body-s2'));
    expect(onActivateSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewVariant).toBe('primary');
  });

  it('promotes from the title bar and activates the full shell only after the promoted primary body is tapped', () => {
    const onActivateSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onClose={vi.fn()}
      />,
    );

    const childTitlebar = screen.getByTestId('terminal-preview-tile-s2').querySelector('[data-preview-titlebar="true"]') as HTMLElement;
    fireEvent.click(childTitlebar);
    expect(onActivateSession).not.toHaveBeenCalled();
    expect(screen.getByTestId('terminal-preview-tile-s2').dataset.previewVariant).toBe('primary');

    fireEvent.click(screen.getByTestId('terminal-preview-body-s2'));
    expect(onActivateSession).toHaveBeenCalledTimes(1);
    expect(onActivateSession).toHaveBeenCalledWith('s2');
  });

  it('keeps order metadata but does not render order badges in tile titlebars', () => {
    const namedSessions = [
      { ...sessions[0], title: 'alpha', sessionName: 'alpha' },
      { ...sessions[1], title: 'beta', sessionName: 'beta' },
    ] as Session[];
    render(
      <TerminalPreviewGrid
        sessions={namedSessions}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const firstTile = screen.getByTestId('terminal-preview-tile-s1');
    const titlebar = firstTile.querySelector('[data-preview-titlebar="true"]');
    expect(firstTile.dataset.previewOrder).toBe('1');
    expect(titlebar?.textContent).toContain('alpha');
    expect(titlebar?.textContent).not.toContain('1');
  });

  it('renders secondary preview tiles with a compact local font without resize callbacks', () => {
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={14}
        onActivateSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const terminalProps = terminalViewSpy.mock.calls.map(([props]) => props as Record<string, unknown>);
    expect(terminalProps.map((props) => [props.sessionId, props.fontSize, props.rowHeight])).toEqual([
      ['s1', 7, '10px'],
      ['s2', 7, '8px'],
      ['s3', 7, '8px'],
    ]);
    for (const props of terminalProps) {
      expect(props.widthMode).toBe('mirror-fixed');
      expect(props.onResize).toBeUndefined();
      expect(props.onWidthModeChange).toBeUndefined();
      expect(props.onViewportChange).toBeUndefined();
    }
  });

  it('removes a preview tile without activating or closing its Session', () => {
    const onActivateSession = vi.fn();
    const onRemoveSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onRemoveSession={onRemoveSession}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText('从预览移除 Session 2'));
    expect(onRemoveSession).toHaveBeenCalledWith('s2');
    expect(onActivateSession).not.toHaveBeenCalled();
  });

  it('adds an unselected Session from the inline add row', () => {
    const onAddSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 4)}
        replacementCandidates={sessions.slice(4, 6)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={vi.fn()}
        onAddSession={onAddSession}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '增加预览窗口' }));
    expect(screen.getByTestId('terminal-preview-add-s5')).toBeTruthy();
    expect(screen.getByTestId('terminal-preview-add-s6')).toBeTruthy();
    expect(screen.queryByTestId('terminal-preview-add-s1')).toBeNull();
    fireEvent.click(screen.getByTestId('terminal-preview-add-s5'));
    expect(onAddSession).toHaveBeenCalledWith('s5');
  });

  it('long presses the title bar to move a tile without opening replacement or activating', () => {
    vi.useFakeTimers();
    const onActivateSession = vi.fn();
    const onMoveSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 4)}
        replacementCandidates={sessions.slice(4, 6)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onMoveSession={onMoveSession}
        onClose={vi.fn()}
      />,
    );

    const titlebar = screen.getByTestId('terminal-preview-tile-s3').querySelector('[data-preview-titlebar="true"]') as HTMLElement;
    fireEvent.pointerDown(titlebar, { clientX: 30, clientY: 80, pointerId: 1 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole('menu', { name: '移动预览 Session 3' })).toBeTruthy();
    expect(screen.queryByTestId('terminal-preview-replacement-menu')).toBeNull();
    fireEvent.pointerUp(titlebar, { clientX: 30, clientY: 80, pointerId: 1 });
    fireEvent.click(screen.getByTestId('terminal-preview-move-to-1'));
    expect(onMoveSession).toHaveBeenCalledWith('s3', 0);
    expect(onActivateSession).not.toHaveBeenCalled();
  });

  it('enables read-only body touch scrolling with smaller preview typography', () => {
    vi.useFakeTimers();
    const onActivateSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 1)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onClose={vi.fn()}
      />,
    );

    const body = screen.getByTestId('terminal-preview-body-s1');
    expect(body.style.pointerEvents).toBe('auto');
    expect(body.style.webkitTextSizeAdjust).toBe('none');
    expect(body.closest('button')).toBeNull();
    fireEvent.pointerDown(body, { clientX: 20, clientY: 70, pointerId: 1 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.touchStart(body, { touches: [{ clientX: 20, clientY: 70 }] });
    fireEvent.touchMove(body, { touches: [{ clientX: 8, clientY: 120 }] });
    fireEvent.click(body);
    expect(onActivateSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-preview-replacement-menu')).toBeNull();
    expect(terminalViewSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 7,
      rowHeight: '10px',
      widthMode: 'mirror-fixed',
      active: false,
      live: true,
      projectionMode: 'preview-primary',
      splitVisible: true,
    }));
  });

  it('exits on a horizontal right swipe but not a vertical gesture', () => {
    const onClose = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 1)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={vi.fn()}
        onClose={onClose}
      />,
    );
    const shell = screen.getByTestId('terminal-preview-grid-shell');
    fireEvent.touchStart(shell, { touches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 110, clientY: 305 }] });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.touchStart(shell, { touches: [{ clientX: 40, clientY: 300 }] });
    fireEvent.touchEnd(shell, { changedTouches: [{ clientX: 45, clientY: 380 }] });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('opens replacement choices on long press without activating the tile', () => {
    vi.useFakeTimers();
    const onActivateSession = vi.fn();
    const onReplaceSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 2)}
        replacementCandidates={sessions.slice(2, 4)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onReplaceSession={onReplaceSession}
        onClose={vi.fn()}
      />,
    );

    const tile = screen.getByTestId('terminal-preview-tile-s1');
    fireEvent.pointerDown(tile, { clientX: 30, clientY: 80, pointerId: 1 });
    act(() => vi.advanceTimersByTime(450));
    expect(screen.getByRole('menu', { name: '替换预览 Session 1' })).toBeTruthy();
    fireEvent.pointerUp(tile, { clientX: 30, clientY: 80, pointerId: 1 });
    fireEvent.click(tile);
    expect(onActivateSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: /Session 3/ }));
    expect(onReplaceSession).toHaveBeenCalledWith('s1', 's3');
    expect(onReplaceSession).toHaveBeenCalledTimes(1);
  });

  it('cancels long press and suppresses activation after pointer movement', () => {
    vi.useFakeTimers();
    const onActivateSession = vi.fn();
    render(
      <TerminalPreviewGrid
        sessions={sessions.slice(0, 2)}
        replacementCandidates={sessions.slice(2, 3)}
        sessionBufferStore={null}
        landscape={false}
        fontSize={10}
        onActivateSession={onActivateSession}
        onReplaceSession={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const tile = screen.getByTestId('terminal-preview-tile-s1');
    fireEvent.pointerDown(tile, { clientX: 30, clientY: 80, pointerId: 1 });
    fireEvent.pointerMove(tile, { clientX: 60, clientY: 80, pointerId: 1 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.pointerUp(tile, { clientX: 60, clientY: 80, pointerId: 1 });
    fireEvent.click(tile);
    expect(screen.queryByTestId('terminal-preview-replacement-menu')).toBeNull();
    expect(onActivateSession).not.toHaveBeenCalled();
  });
});
