// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TerminalTabSwipeSurface } from './TerminalTabSwipeSurface';

afterEach(() => {
  cleanup();
});

describe('TerminalTabSwipeSurface', () => {
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
    fireEvent.touchStart(surface, { touches: [{ clientX: 220, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 120, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 120, clientY: 166 }] });

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
    fireEvent.touchStart(surface, { touches: [{ clientX: 120, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 220, clientY: 166 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 220, clientY: 166 }] });

    expect(onSwipeTab).toHaveBeenCalledWith('s1', 'previous');
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
    fireEvent.touchStart(surface, { touches: [{ clientX: 180, clientY: 160 }] });
    fireEvent.touchMove(surface, {
      touches: [{ clientX: 190, clientY: 272 }],
      cancelable: true,
    });
    fireEvent.touchEnd(surface, { changedTouches: [{ clientX: 190, clientY: 272 }] });

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
