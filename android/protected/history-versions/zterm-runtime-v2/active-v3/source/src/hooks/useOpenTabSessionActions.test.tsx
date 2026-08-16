// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useOpenTabSessionActions } from './useOpenTabSessionActions';

function createRef<T>(value: T) {
  return { current: value };
}

describe('useOpenTabSessionActions transport semantics', () => {
  it('marks tab switch as explicit-resume so transport reopen stays user-owned', () => {
    const applyOpenTabState = vi.fn();
    const ensureTerminalPageVisible = vi.fn();

    const { result } = renderHook(() => useOpenTabSessionActions({
      openTabStateRef: createRef({
        tabs: [
          { sessionId: 's1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'one', createdAt: 1 },
          { sessionId: 's2', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'two', createdAt: 2 },
        ],
        activeSessionId: 's1',
      } as any),
      sessionsRef: createRef([]),
      runtimeActiveSessionIdRef: createRef('s1'),
      applyOpenTabState,
      ensureTerminalPageVisible,
      moveSession: vi.fn(),
      renameSession: vi.fn(),
      applyClosedOpenTabIntent: vi.fn(),
    }));

    act(() => {
      result.current.handleSwitchSession('s2');
    });

    expect(applyOpenTabState).toHaveBeenCalledTimes(1);
    expect(applyOpenTabState).toHaveBeenCalledWith(
      expect.objectContaining({ activeSessionId: 's2' }),
      expect.objectContaining({ switchRuntime: 'explicit-resume' }),
    );
    expect(ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });

  it('commits active tab truth when resume opens transport so the first tap changes the target', () => {
    const applyOpenTabState = vi.fn();
    const ensureTerminalPageVisible = vi.fn();

    const { result } = renderHook(() => useOpenTabSessionActions({
      openTabStateRef: createRef({
        tabs: [
          { sessionId: 's1', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'one', createdAt: 1 },
          { sessionId: 's2', bridgeHost: '127.0.0.1', bridgePort: 3333, sessionName: 'two', createdAt: 2 },
        ],
        activeSessionId: 's1',
      } as any),
      sessionsRef: createRef([]),
      runtimeActiveSessionIdRef: createRef('s1'),
      applyOpenTabState,
      ensureTerminalPageVisible,
      moveSession: vi.fn(),
      renameSession: vi.fn(),
      applyClosedOpenTabIntent: vi.fn(),
    }));

    act(() => {
      result.current.handleResumeSession('s2');
    });

    expect(applyOpenTabState).toHaveBeenCalledTimes(1);
    expect(applyOpenTabState).toHaveBeenCalledWith(
      expect.objectContaining({ activeSessionId: 's2' }),
      expect.objectContaining({ switchRuntime: 'explicit-resume' }),
    );
    expect(ensureTerminalPageVisible).toHaveBeenCalledTimes(1);
  });
});
