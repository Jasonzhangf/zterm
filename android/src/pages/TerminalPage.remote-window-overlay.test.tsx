// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keyboard } from '@capacitor/keyboard';
import type { RemoteWindowStreamTargetManifest, Session } from '../lib/types';
import { TerminalPage } from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
  },
  registerPlugin: () => ({
    readText: vi.fn(async () => ({ value: '' })),
    writeText: vi.fn(async () => undefined),
  }),
}));

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
  },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: {
    ExternalStorage: 'EXTERNAL',
  },
  Filesystem: {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
  },
}));

vi.mock('../plugins/ImeAnchorPlugin', () => ({
  ImeAnchor: {
    show: vi.fn(async () => ({})),
    hide: vi.fn(async () => undefined),
    blur: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
  },
}));

vi.mock('../components/terminal/TerminalHeader', () => ({
  TerminalHeader: () => <div data-testid="terminal-header" />,
}));

vi.mock('../components/terminal/TabManagerSheet', () => ({
  TabManagerSheet: () => null,
}));

vi.mock('../components/terminal/SessionScheduleSheet', () => ({
  SessionScheduleSheet: () => null,
}));

vi.mock('../components/terminal/FileTransferSheet', () => ({
  FileTransferSheet: () => null,
}));

vi.mock('../components/terminal/RemoteScreenshotSheet', () => ({
  RemoteScreenshotSheet: () => null,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-view-${sessionId}`} />,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: ({
    onSendSequence,
    onSessionDraftSend,
    onToggleKeyboard,
    remoteWindowInputActive,
  }: {
    onSendSequence?: (sequence: string) => void;
    onSessionDraftSend?: (value: string) => void;
    onToggleKeyboard?: () => void;
    remoteWindowInputActive?: boolean;
  }) => (
    <div
      data-testid="terminal-quickbar"
      data-remote-window-input-active={remoteWindowInputActive ? 'true' : 'false'}
    >
      <button type="button" onClick={() => onSendSequence?.('\x1b[A')}>quickbar-arrow-up</button>
      <button type="button" onClick={() => onSessionDraftSend?.('继续执行\r')}>quickbar-send-draft</button>
      <button type="button" onClick={() => onToggleKeyboard?.()}>quickbar-keyboard</button>
    </div>
  ),
}));

function makeSession(id: string): Session {
  return {
    id,
    hostId: `host-${id}`,
    connectionName: `conn-${id}`,
    bridgeHost: '100.127.23.27',
    bridgePort: 3333,
    sessionName: `tmux-${id}`,
    title: `tab-${id}`,
    ws: null,
    state: 'connected',
    hasUnread: false,
    createdAt: 1,
    buffer: {
      lines: [],
      gapRanges: [],
      startIndex: 0,
      endIndex: 0,
      bufferHeadStartIndex: 0,
      bufferTailEndIndex: 0,
      cols: 80,
      rows: 24,
      cursorKeysApp: false,
      cursor: null,
      updateKind: 'replace',
      revision: 1,
    },
  };
}

function makeTarget(): RemoteWindowStreamTargetManifest {
  return {
    streamTargetId: 'app-1',
    videoTarget: {
      kind: 'app-window',
      appBundleId: 'com.apple.TextEdit',
      pid: 123,
      windowId: 'window-1',
      title: 'TextEdit',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 40, width: 800, height: 560 },
    },
    inputTarget: {
      kind: 'app-window',
    },
    streamMode: 'interactive',
    focusPolicy: 'bring-to-focus',
    inputRoute: 'os-event',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-19T00:00:00.000Z',
    },
  };
}

describe('TerminalPage remote window overlay', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens the picker through the active session and routes fullscreen quickbar input to the remote window', async () => {
    const session = makeSession('s1');
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const onRequestRemoteWindowTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeTarget()],
      errors: [],
    }));
    const onRequestRemoteWindowStreamStart = vi.fn(async (
      _sessionId: string,
      _target: RemoteWindowStreamTargetManifest,
      streamId: string,
    ) => ({
      streamId,
      mediaStream,
      started: {
        requestId: 'rw-start-1',
        streamId,
        targetId: 'app-1',
        answer: { type: 'answer' as const, sdp: 'v=0' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 800,
          frameHeight: 560,
          frameRate: 30,
          targetKind: 'app-window' as const,
        },
        transport: {
          kind: 'webrtc-video' as const,
        },
      },
    }));
    const onSendRemoteWindowInput = vi.fn();
    const onQuickActionInput = vi.fn();
    const onSessionDraftSend = vi.fn();
    const onActiveBodySubscriptionSuppressedChange = vi.fn();

    render(
      <TerminalPage
        sessions={[session]}
        activeSession={session}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onActiveBodySubscriptionSuppressedChange={onActiveBodySubscriptionSuppressedChange}
        onRequestRemoteWindowTargets={onRequestRemoteWindowTargets}
        onRequestRemoteWindowStreamStart={onRequestRemoteWindowStreamStart}
        onSendRemoteWindowInput={onSendRemoteWindowInput}
        onQuickActionInput={onQuickActionInput}
        onSessionDraftSend={onSessionDraftSend}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    await waitFor(() => {
      expect(onRequestRemoteWindowTargets).toHaveBeenCalledWith('s1');
      expect(screen.getByTestId('remote-window-target-app-1')).toBeTruthy();
      expect(screen.queryByTestId('terminal-quickbar')).toBeNull();
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenCalledWith(true);
    });

    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-locked-overlay').getAttribute('data-mode')).toBe('floating');
      expect(onRequestRemoteWindowStreamStart).toHaveBeenCalledWith('s1', expect.objectContaining({
        streamTargetId: 'app-1',
      }), expect.stringMatching(/^rw-stream-/));
      expect(screen.getByTestId('remote-window-video')).toBeTruthy();
      expect(screen.queryByTestId('terminal-view-s1')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-remote-window-input-active')).toBe('true');
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });

    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar-shell').getAttribute('style') || '').toContain('z-index: 96');
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(true);
    });

    fireEvent.click(screen.getByText('quickbar-arrow-up'));
    await waitFor(() => {
      expect(onSendRemoteWindowInput).toHaveBeenCalledWith('s1', expect.objectContaining({
        streamId: expect.stringMatching(/^rw-stream-/),
        targetId: 'app-1',
        event: expect.objectContaining({
          kind: 'key',
          phase: 'down',
          key: 'ArrowUp',
          code: 'ArrowUp',
        }),
      }));
      expect(onQuickActionInput).not.toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText('quickbar-send-draft'));
    await waitFor(() => {
      expect(onSendRemoteWindowInput).toHaveBeenCalledWith('s1', expect.objectContaining({
        targetId: 'app-1',
        event: expect.objectContaining({
          kind: 'key',
          phase: 'down',
          key: '继续执行',
          text: '继续执行',
        }),
      }));
      expect(onSendRemoteWindowInput).toHaveBeenCalledWith('s1', expect.objectContaining({
        targetId: 'app-1',
        event: expect.objectContaining({
          kind: 'key',
          phase: 'down',
          key: 'Enter',
          code: 'Enter',
        }),
      }));
      expect(onSessionDraftSend).not.toHaveBeenCalled();
    });

    fireEvent.click(screen.getByText('quickbar-keyboard'));
    await waitFor(() => {
      expect(Keyboard.show).toHaveBeenCalled();
    });

    fireEvent.click(screen.getByRole('button', { name: '缩小远程窗口' }));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-remote-window-input-active')).toBe('true');
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭远程窗口' }));
    await waitFor(() => {
      expect(screen.queryByTestId('remote-window-locked-overlay')).toBeNull();
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });
  });
});
