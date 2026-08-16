// @vitest-environment jsdom

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useTerminalShellActions } from './useTerminalShellActions';

describe('useTerminalShellActions', () => {
  it('does not send rows in default adaptive-phone resize writes', async () => {
    const sendTerminalResize = vi.fn();

    function Harness() {
      const actions = useTerminalShellActions({
        sendInput: vi.fn(),
        updateSessionViewport: vi.fn(),
        sendTerminalResize,
        getSessionRenderBufferStore: () => ({ getSnapshot: () => ({ buffer: null }) } as any),
        setSessionDraft: vi.fn(),
        clearSessionDraft: vi.fn(),
        pruneDrafts: vi.fn(),
        sessionIds: ['session-1'],
        runtimeRefs: {
          openTabStateRef: { current: { activeSessionId: 'session-1' } } as any,
          terminalActiveSessionIdRef: { current: 'session-1' } as any,
        },
        handleSwitchSession: vi.fn(),
        bridgeSettings: {
          terminalWidthMode: 'adaptive-phone',
          shortcutSmartSort: false,
        } as any,
        shortcutFrequencyStorage: {
          getFrequencyMap: () => ({}),
          recordShortcutUse: vi.fn(),
        },
      });

      return (
        <button type="button" onClick={() => actions.handleTerminalResize('session-1', 101, 37)}>
          resize
        </button>
      );
    }

    render(<Harness />);

    await act(async () => {
      screen.getByText('resize').click();
    });

    expect(sendTerminalResize).toHaveBeenCalledTimes(1);
    expect(sendTerminalResize).toHaveBeenCalledWith('session-1', 101, undefined, 'adaptive-phone');
  });

  it('sends mirror-fixed mode without upstream cols/rows writes', async () => {
    const sendTerminalResize = vi.fn();

    function Harness() {
      const actions = useTerminalShellActions({
        sendInput: vi.fn(),
        updateSessionViewport: vi.fn(),
        sendTerminalResize,
        getSessionRenderBufferStore: () => ({ getSnapshot: () => ({ buffer: null }) } as any),
        setSessionDraft: vi.fn(),
        clearSessionDraft: vi.fn(),
        pruneDrafts: vi.fn(),
        sessionIds: ['session-1'],
        runtimeRefs: {
          openTabStateRef: { current: { activeSessionId: 'session-1' } } as any,
          terminalActiveSessionIdRef: { current: 'session-1' } as any,
        },
        handleSwitchSession: vi.fn(),
        bridgeSettings: {
          terminalWidthMode: 'mirror-fixed',
          shortcutSmartSort: false,
        } as any,
        shortcutFrequencyStorage: {
          getFrequencyMap: () => ({}),
          recordShortcutUse: vi.fn(),
        },
      });

      return (
        <button type="button" onClick={() => actions.handleTerminalWidthModeChange('session-1', 'mirror-fixed', 81)}>
          width-mode
        </button>
      );
    }

    render(<Harness />);

    await act(async () => {
      screen.getByText('width-mode').click();
    });

    expect(sendTerminalResize).toHaveBeenCalledTimes(1);
    expect(sendTerminalResize).toHaveBeenCalledWith('session-1', undefined, undefined, 'mirror-fixed');
  });
});
