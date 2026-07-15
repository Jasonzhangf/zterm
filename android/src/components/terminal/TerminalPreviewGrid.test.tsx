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
    [false, 1, 1, 1],
    [false, 2, 2, 1],
    [false, 3, 2, 2],
    [false, 4, 2, 2],
    [false, 5, 2, 3],
    [false, 6, 2, 3],
    [true, 1, 1, 1],
    [true, 2, 2, 1],
    [true, 3, 3, 1],
    [true, 4, 3, 2],
    [true, 5, 3, 2],
    [true, 6, 3, 2],
  ])('derives %s orientation layout for %i selected sessions as %ix%i', (landscape, count, columns, rows) => {
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
    expect(grid.dataset.columns).toBe(String(columns));
    expect(grid.dataset.rows).toBe(String(rows));
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(count);
  });

  it('renders six ordered read-only terminals in portrait 2x3 layout', () => {
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
    expect(grid.dataset.columns).toBe('2');
    expect(grid.dataset.rows).toBe('3');
    expect(screen.getAllByTestId(/terminal-preview-tile-/)).toHaveLength(6);
    expect(terminalViewSpy).toHaveBeenCalledTimes(6);
    for (const [props] of terminalViewSpy.mock.calls) {
      expect(props).toMatchObject({ active: false, live: true });
      expect((props as Record<string, unknown>).onInput).toBeUndefined();
      expect((props as Record<string, unknown>).onResize).toBeUndefined();
      expect((props as Record<string, unknown>).onViewportChange).toBeUndefined();
    }

    fireEvent.click(screen.getByTestId('terminal-preview-tile-s4'));
    expect(onActivateSession).toHaveBeenCalledWith('s4');
  });

  it('uses landscape 3x2 layout and exposes close command', () => {
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
    expect(screen.getByTestId('terminal-preview-grid').dataset.columns).toBe('2');
    expect(screen.getByTestId('terminal-preview-grid').dataset.rows).toBe('1');
    fireEvent.click(screen.getByLabelText('退出终端预览'));
    expect(onClose).toHaveBeenCalledTimes(1);
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
    expect(body.closest('button')).toBeNull();
    fireEvent.pointerDown(body, { clientX: 20, clientY: 70, pointerId: 1 });
    act(() => vi.advanceTimersByTime(450));
    fireEvent.touchStart(body, { touches: [{ clientX: 20, clientY: 70 }] });
    fireEvent.touchMove(body, { touches: [{ clientX: 8, clientY: 120 }] });
    fireEvent.click(body);
    expect(onActivateSession).not.toHaveBeenCalled();
    expect(screen.queryByTestId('terminal-preview-replacement-menu')).toBeNull();
    expect(terminalViewSpy).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 6,
      rowHeight: '9px',
      widthMode: 'mirror-fixed',
      active: false,
      live: true,
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
