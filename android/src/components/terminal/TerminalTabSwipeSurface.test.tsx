// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TerminalTabSwipeSurface } from './TerminalTabSwipeSurface';

afterEach(() => {
  cleanup();
});

describe('TerminalTabSwipeSurface', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 640 });
  });

  it('switches to the next tab on left swipe', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 610, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 500, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 500, clientY: 166 }] });

    expect(onSwipeTab).toHaveBeenCalledWith('s1', 'next');
  });

  it('switches to the previous tab on right swipe', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 56, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 174, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 174, clientY: 166 }] });

    expect(onSwipeTab).toHaveBeenCalledWith('s1', 'previous');
  });

  it('does not start the left drawer swipe from the widened-but-not-edge area', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '390px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          allowedStartEdge="left"
          allowedDirections="previous"
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 88, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 220, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 220, clientY: 166 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
  });

  it('does not trigger tab swipe from the middle of the screen', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 220, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 120, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 120, clientY: 166 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
  });

  it('does not start from the right edge when only the left drawer edge is allowed', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          allowedStartEdge="left"
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 610, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 500, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 500, clientY: 166 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
  });

  it('keeps fixed-width drawer mode from switching to next tab from the left edge', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          allowedStartEdge="left"
          allowedDirections="previous"
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 56, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 10, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 10, clientY: 166 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
  });

  it('keeps vertical scroll gestures from triggering tab swipe', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 48, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 58, clientY: 272 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 58, clientY: 272 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
  });

  it('does not trigger tab swipe when disabled', () => {
    const onSwipeTab = vi.fn();
    const view = render(
      <div style={{ width: '640px', height: '408px' }}>
        <TerminalTabSwipeSurface
          sessionId="s1"
          active
          enabled={false}
          onSwipeTab={onSwipeTab}
        >
          <div data-testid="body" />
        </TerminalTabSwipeSurface>
      </div>,
    );

    const surface = view.getByTestId('terminal-swipe-surface-s1');
    fireEvent.touchStart(surface, { touches: [{ clientX: 220, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 120, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 120, clientY: 166 }] });

    expect(onSwipeTab).not.toHaveBeenCalled();
    expect(surface.getAttribute('data-swipe-enabled')).toBe('false');
  });
});
