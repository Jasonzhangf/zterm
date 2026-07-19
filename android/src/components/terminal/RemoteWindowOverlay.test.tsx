// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RemoteWindowOverlay } from './RemoteWindowOverlay';
import type { RemoteWindowStreamTargetManifest } from '../../lib/types';

const backListeners: Array<() => void> = [];

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async (_event: string, handler: () => void) => {
      backListeners.push(handler);
      return {
        remove: vi.fn(() => {
          const index = backListeners.indexOf(handler);
          if (index >= 0) {
            backListeners.splice(index, 1);
          }
        }),
      };
    }),
  },
}));

function makeTarget(id: string, title: string, kind: 'app-window' | 'iterm2-pane'): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: id,
    videoTarget: {
      kind,
      appBundleId: kind === 'iterm2-pane' ? 'com.googlecode.iterm2' : 'com.apple.TextEdit',
      pid: 123,
      windowId: 'window-1',
      title,
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 40, width: 800, height: 560 },
    },
    inputTarget: kind === 'iterm2-pane'
      ? { kind: 'tmux-pane', itermSessionId: 'iterm-1', tty: '/dev/ttys001', tmuxSession: 'zterm', tmuxWindowId: '@1', tmuxPaneId: '%2' }
      : { kind: 'app-window' },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: kind === 'iterm2-pane' ? 'tmux-input' : 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

describe('RemoteWindowOverlay', () => {
  afterEach(() => {
    cleanup();
    backListeners.splice(0, backListeners.length);
  });

  it('opens the picker from the floating entry and renders daemon catalog rows', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [
        makeTarget('app-1', 'TextEdit', 'app-window'),
        makeTarget('pane-1', 'zterm pane', 'iterm2-pane'),
      ],
      errors: [{ requestId: 'rw-1', code: 'iterm2_partial', message: 'partial source warning' }],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    expect(requestTargets).toHaveBeenCalledWith('session-1');
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-target-app-1')).toBeTruthy();
      expect(screen.getByTestId('remote-window-target-pane-1')).toBeTruthy();
      expect(screen.getByTestId('remote-window-partial-errors').textContent).toContain('iterm2_partial');
    });
  });

  it('selects a target, expands to fullscreen, shrinks on Back, and closes explicitly', async () => {
    const requestTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget('pane-1', 'zterm pane', 'iterm2-pane')],
    }));

    render(<RemoteWindowOverlay activeSessionId="session-1" requestTargets={requestTargets} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-pane-1');
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    const overlay = screen.getByTestId('remote-window-locked-overlay');
    expect(overlay.getAttribute('data-mode')).toBe('floating');
    expect(screen.getByText('等待视频流')).toBeTruthy();

    fireEvent.doubleClick(overlay);
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('fullscreen');
    });
    expect(backListeners.length).toBe(1);

    backListeners[0]?.();
    await waitFor(() => {
      expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('floating');
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    await waitFor(() => {
      expect(screen.queryByTestId('remote-window-locked-overlay')).toBeNull();
      expect(screen.getByRole('button', { name: '打开远程窗口' })).toBeTruthy();
    });
  });

  it('surfaces missing active session as an explicit picker error', async () => {
    render(<RemoteWindowOverlay activeSessionId={null} requestTargets={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-picker-error').textContent).toContain('当前没有可用的 daemon session');
    });
  });
});
