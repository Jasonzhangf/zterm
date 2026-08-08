// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Keyboard } from '@capacitor/keyboard';
import { Filesystem } from '@capacitor/filesystem';
import type { RemoteWindowStreamTargetManifest, Session } from '../lib/types';
import { TerminalPage } from './TerminalPage';

// TerminalPage reads attachment counts from SessionContext (badge/drawer).
// These page-level tests render TerminalPage directly without the app-level
// SessionProvider, so provide the minimal session facade the page consumes.
vi.mock('../contexts/SessionContext', () => ({
  useSession: () => ({
    getPendingAttachmentCount: () => 0,
    getPendingAttachments: () => [],
  }),
}));

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
    activeSessionId,
    onSendSequence,
    onSessionDraftSend,
    onImagePaste,
    onToggleKeyboard,
    onToggleDebugOverlay,
    remoteWindowInputActive,
    onMeasuredHeightChange,
  }: {
    activeSessionId?: string | null;
    onSendSequence?: (sequence: string) => void;
    onSessionDraftSend?: (value: string) => void;
    onImagePaste?: (sessionId: string, file: File) => void;
    onToggleKeyboard?: () => void;
    onToggleDebugOverlay?: () => void;
    remoteWindowInputActive?: boolean;
    onMeasuredHeightChange?: (height: number) => void;
  }) => {
    return (
      <div
        data-testid="terminal-quickbar"
        data-remote-window-input-active={remoteWindowInputActive ? 'true' : 'false'}
        ref={(element) => {
          if (element) {
            onMeasuredHeightChange?.(112);
          }
        }}
      >
        <button type="button" onClick={() => onSendSequence?.('\x1b[A')}>quickbar-arrow-up</button>
        <button type="button" onClick={() => onSessionDraftSend?.('继续执行\r')}>quickbar-send-draft</button>
        <button
          type="button"
          onClick={() => activeSessionId && onImagePaste?.(
            activeSessionId,
            new File(['image'], 'proof.png', { type: 'image/png' }),
          )}
        >
          quickbar-image
        </button>
        <button type="button" onClick={() => onToggleKeyboard?.()}>quickbar-keyboard</button>
        <button type="button" onClick={() => onToggleDebugOverlay?.()}>状态</button>
      </div>
    );
  },
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

function makeItermTarget(): RemoteWindowStreamTargetManifest {
  return {
    ...makeTarget(),
    streamTargetId: 'pane-1',
    videoTarget: {
      kind: 'iterm2-pane',
      appBundleId: 'com.googlecode.iterm2',
      pid: 456,
      windowId: 'window-2',
      title: 'zterm pane',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      cropRectTopLeftPx: { x: 10, y: 40, width: 800, height: 560 },
    },
    inputTarget: {
      kind: 'tmux-pane',
      itermSessionId: 'iterm-1',
      tty: '/dev/ttys001',
      tmuxSession: 'zterm',
      tmuxWindowId: '@1',
      tmuxPaneId: '%2',
    },
    inputRoute: 'tmux-input',
  };
}

function expectNoRemoteWindowInputFocus(sendInput: ReturnType<typeof vi.fn>) {
  const payloads = sendInput.mock.calls.map((call) => call[1]);
  expect(payloads.some((payload) => payload?.event?.kind === 'focus')).toBe(false);
}

function remoteWindowPayloads(sendInput: ReturnType<typeof vi.fn>) {
  return sendInput.mock.calls
    .map((call) => call[1])
    .filter(Boolean);
}

describe('TerminalPage remote window overlay', () => {
  afterEach(() => {
    vi.restoreAllMocks();
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
    const onImagePaste = vi.fn();
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
        onImagePaste={onImagePaste}
        onQuickActionInput={onQuickActionInput}
        onSessionDraftSend={onSessionDraftSend}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByTestId('terminal-stage-shell').getAttribute('style') || '').toMatch(/bottom: (?!0px)\d+px/);
    });
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));

    await waitFor(() => {
      expect(onRequestRemoteWindowTargets).toHaveBeenCalledWith('s1');
      expect(screen.getByTestId('remote-window-target-app-1')).toBeTruthy();
      // 与文件按键一致：picker 打开时 QuickBar 保留，terminal stage 底部不置 0
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(screen.getByTestId('terminal-stage-shell').getAttribute('style') || '').toMatch(/bottom: (?!0px)\d+px/);
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenCalledWith(true);
    });

    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));

    await waitFor(() => {
      const lockedOverlay = screen.getByTestId('remote-window-locked-overlay');
      expect(lockedOverlay.getAttribute('data-mode')).toBe('floating');
      expect(parseFloat(lockedOverlay.style.bottom || '0')).toBeGreaterThan(200);
      expect(onRequestRemoteWindowStreamStart).toHaveBeenCalledWith('s1', expect.objectContaining({
        streamTargetId: 'app-1',
      }), expect.stringMatching(/^rw-stream-/), expect.objectContaining({
        purpose: 'preview',
        videoBitrate: { preset: '2mbps', bitrateMbps: 2, maxBitrateBps: 2_000_000, maxFrameRateFps: 30 },
      }));
      expect(screen.getByTestId('remote-window-video')).toBeTruthy();
      expect(screen.queryByTestId('terminal-view-s1')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-remote-window-input-active')).toBe('true');
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });

    fireEvent.click(screen.getByText('quickbar-image'));
    await waitFor(() => {
      expect(onImagePaste).toHaveBeenCalledWith('s1', expect.any(File), {
        pasteTarget: {
          kind: 'remote-window',
          streamId: expect.stringMatching(/^rw-stream-/),
          targetId: 'app-1',
        },
      });
    });

    fireEvent.pointerDown(screen.getByTestId('terminal-pane-shell'));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-remote-window-input-active')).toBe('false');
    });
    fireEvent.click(screen.getByText('quickbar-image'));
    await waitFor(() => {
      expect(onImagePaste).toHaveBeenLastCalledWith('s1', expect.any(File));
    });

    fireEvent.click(screen.getByRole('button', { name: '全屏远程窗口' }));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar-shell').getAttribute('style') || '').toContain('z-index: 96');
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(true);
    });

    onSendRemoteWindowInput.mockClear();
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
    expect(onSendRemoteWindowInput.mock.calls.map((call) => call[1].event.kind)).toEqual([
      'key',
      'key',
    ]);
    expectNoRemoteWindowInputFocus(onSendRemoteWindowInput);

    onSendRemoteWindowInput.mockClear();
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
    expectNoRemoteWindowInputFocus(onSendRemoteWindowInput);

    fireEvent.click(screen.getByRole('button', { name: '调起远程窗口键盘' }));
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

  it('routes phone video-surface tap and touch drag through remote-window input instead of terminal input', async () => {
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
          frameRate: 12,
          targetKind: 'app-window' as const,
        },
        transport: {
          kind: 'webrtc-video' as const,
        },
      },
    }));
    const onSendRemoteWindowInput = vi.fn();
    const onTerminalInput = vi.fn();
    let remoteWindowMessageHandler: ((msg: any) => void) | null = null;
    const onRemoteWindowMessage = vi.fn((handler: (msg: any) => void) => {
      remoteWindowMessageHandler = handler;
      return () => {
        if (remoteWindowMessageHandler === handler) {
          remoteWindowMessageHandler = null;
        }
      };
    });

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
        onTerminalInput={onTerminalInput}
        onTerminalViewportChange={vi.fn()}
        onRequestRemoteWindowTargets={onRequestRemoteWindowTargets}
        onRequestRemoteWindowStreamStart={onRequestRemoteWindowStreamStart}
        onSendRemoteWindowInput={onSendRemoteWindowInput}
        onRemoteWindowMessage={onRemoteWindowMessage}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    const surface = screen.getByTestId('remote-window-video-surface');
    Object.defineProperty(surface, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 200,
        bottom: 100,
        width: 200,
        height: 100,
        toJSON: () => ({}),
      }),
    });

    fireEvent.pointerDown(surface, {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 100,
      clientY: 50,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerUp(surface, {
      pointerId: 31,
      pointerType: 'touch',
      clientX: 100,
      clientY: 50,
      button: 0,
      buttons: 0,
    });

    await waitFor(() => {
      expect(remoteWindowPayloads(onSendRemoteWindowInput)).toHaveLength(1);
    });
    expectNoRemoteWindowInputFocus(onSendRemoteWindowInput);
    expect(onSendRemoteWindowInput.mock.calls.map((call) => call[1].event.kind)).toEqual([
      'click',
    ]);
    expect(remoteWindowPayloads(onSendRemoteWindowInput)[0]).toMatchObject({
      streamId: expect.stringMatching(/^rw-stream-/),
      targetId: 'app-1',
      event: {
        kind: 'click',
        pointerId: 31,
        button: 'left',
        normalizedX: 0.5,
        normalizedY: 0.5,
        x: 410,
        y: 320,
      },
    });
    expect(onTerminalInput).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '状态' }));
    await waitFor(() => {
      expect(screen.getByTestId('terminal-debug-remote-window-context').textContent).toContain('CTX Y');
      expect(screen.getByTestId('terminal-debug-remote-window-event').textContent).toContain('overlay · SEND Y · click #31 left');
      expect(screen.getByTestId('terminal-debug-remote-window-point').textContent).toContain('410,320 n=0.50,0.50');
      expect(screen.getByTestId('terminal-debug-remote-window-counts').textContent).toContain('F 0 · D 0 · M 0 · U 0 · C 1');
      expect(screen.getByTestId('terminal-debug-remote-window-video').textContent).toContain('aY');
      expect(screen.getByTestId('terminal-debug-remote-window-video').textContent).toContain('vN');
    });

    const firstPayload = remoteWindowPayloads(onSendRemoteWindowInput)[0];
    act(() => {
      remoteWindowMessageHandler?.({
        type: 'remote-window-input-result',
        payload: {
          requestId: 'rw-input-accepted-1',
          streamId: firstPayload.streamId,
          targetId: firstPayload.targetId,
          accepted: true,
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-debug-remote-window-result').textContent).toContain('ACK rw-input-accepted-1');
      expect(screen.getByTestId('terminal-debug-remote-window-counts').textContent).toContain('A 1 · E 0');
    });

    act(() => {
      remoteWindowMessageHandler?.({
        type: 'remote-window-error',
        payload: {
          requestId: 'rw-input-error-1',
          streamId: firstPayload.streamId,
          code: 'remote_window_input_failed',
          message: 'remote window input stale',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('terminal-debug-remote-window-result').textContent).toContain('ERR remote_window_input_failed');
      expect(screen.getByTestId('terminal-debug-remote-window-counts').textContent).toContain('A 1 · E 1');
    });

    onSendRemoteWindowInput.mockClear();
    fireEvent.pointerDown(surface, {
      pointerId: 32,
      pointerType: 'touch',
      clientX: 100,
      clientY: 70,
      button: 0,
      buttons: 1,
    });
    fireEvent.pointerMove(surface, {
      pointerId: 32,
      pointerType: 'touch',
      clientX: 100,
      clientY: 40,
      button: 0,
      buttons: 1,
    });
    expect(onSendRemoteWindowInput).not.toHaveBeenCalled();
    fireEvent.pointerUp(surface, {
      pointerId: 32,
      pointerType: 'touch',
      clientX: 100,
      clientY: 40,
      button: 0,
      buttons: 0,
    });

    await waitFor(() => {
      expect(remoteWindowPayloads(onSendRemoteWindowInput)).toHaveLength(1);
    });
    expectNoRemoteWindowInputFocus(onSendRemoteWindowInput);
    expect(onSendRemoteWindowInput.mock.calls.map((call) => call[1].event.kind)).toEqual([
      'gesture',
    ]);
    expect(remoteWindowPayloads(onSendRemoteWindowInput).map((payload) => payload.event)).toEqual([
      expect.objectContaining({
        kind: 'gesture',
        gesture: 'swipe',
        phase: 'end',
        pointerId: 32,
        startNormalizedX: 0.5,
        startNormalizedY: 0.7,
        normalizedX: 0.5,
        normalizedY: 0.4,
        deltaX: 0,
        deltaY: -140,
      }),
    ]);
    expect(onTerminalInput).not.toHaveBeenCalled();

    await waitFor(() => {
      expect(screen.getByTestId('terminal-debug-remote-window-event').textContent).toContain('overlay · SEND Y · gesture:swipe/end');
      expect(screen.getByTestId('terminal-debug-remote-window-counts').textContent).toContain('F 0 · D 0 · M 0 · U 0 · C 1 · S 0 · K 0 · T 0 · A 1');
    });
  });

  it('invalidates the remote-window overlay when daemon reports the input stream is missing', async () => {
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
          frameRate: 12,
          targetKind: 'app-window' as const,
        },
        transport: {
          kind: 'webrtc-video' as const,
        },
      },
    }));
    const onSendRemoteWindowInput = vi.fn();
    let remoteWindowMessageHandler: ((msg: any) => void) | null = null;
    const onRemoteWindowMessage = vi.fn((handler: (msg: any) => void) => {
      remoteWindowMessageHandler = handler;
      return () => {
        if (remoteWindowMessageHandler === handler) {
          remoteWindowMessageHandler = null;
        }
      };
    });

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
        onRequestRemoteWindowTargets={onRequestRemoteWindowTargets}
        onRequestRemoteWindowStreamStart={onRequestRemoteWindowStreamStart}
        onSendRemoteWindowInput={onSendRemoteWindowInput}
        onRemoteWindowMessage={onRemoteWindowMessage}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');

    await waitFor(() => {
      expect(onRequestRemoteWindowStreamStart).toHaveBeenCalledTimes(2);
    });
    const streamId = onRequestRemoteWindowStreamStart.mock.calls[1]?.[2] || '';
    expect(streamId).toEqual(expect.stringMatching(/^rw-stream-/));

    act(() => {
      remoteWindowMessageHandler?.({
        type: 'remote-window-error',
        payload: {
          requestId: 'rw-input-stale-stream',
          streamId,
          code: 'remote_window_input_stream_missing',
          message: 'remote window stream is not active',
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-stream-error').textContent).toContain('remote window stream is not active');
    });
    expect(screen.queryByTestId('remote-window-video')).toBeNull();
  });

  it('stops the remote-window stream when the app goes to background', async () => {
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
    const onStopRemoteWindowStream = vi.fn(() => true);
    const onActiveBodySubscriptionSuppressedChange = vi.fn();

    const renderPage = (appForegroundActive: boolean) => (
      <TerminalPage
        appForegroundActive={appForegroundActive}
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
        onStopRemoteWindowStream={onStopRemoteWindowStream}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />
    );

    const view = render(renderPage(true));
    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await waitFor(() => expect(screen.getByTestId('remote-window-video')).toBeTruthy());

    view.rerender(renderPage(false));
    await waitFor(() => {
      expect(onStopRemoteWindowStream).toHaveBeenCalledWith('s1', expect.stringMatching(/^rw-stream-/));
      expect(screen.queryByTestId('remote-window-locked-overlay')).toBeNull();
      expect(screen.getByTestId('terminal-quickbar')).toBeTruthy();
      expect(onActiveBodySubscriptionSuppressedChange).toHaveBeenLastCalledWith(false);
    });
  });

  it('saves a remote-window screenshot through the existing screenshot transfer path without focusing input', async () => {
    const session = makeSession('s1');
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const canvasToDataUrl = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => {
      throw new Error('local video canvas screenshot must not be used');
    });
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
    const onRequestRemoteScreenshot = vi.fn(async () => ({
      fileName: 'remote-window-TextEdit.png',
      mimeType: 'image/png' as const,
      dataBase64: 'cG5n',
      totalBytes: 3,
    }));
    const onSendRemoteWindowInput = vi.fn();

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
        onRequestRemoteScreenshot={onRequestRemoteScreenshot}
        onRequestRemoteWindowTargets={onRequestRemoteWindowTargets}
        onRequestRemoteWindowStreamStart={onRequestRemoteWindowStreamStart}
        onSendRemoteWindowInput={onSendRemoteWindowInput}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-target-app-1');
    fireEvent.click(screen.getByTestId('remote-window-target-app-1'));
    await screen.findByTestId('remote-window-video');
    onSendRemoteWindowInput.mockClear();

    fireEvent.click(screen.getByRole('button', { name: '截屏远程窗口' }));

    await waitFor(() => {
      expect(onRequestRemoteScreenshot).toHaveBeenCalledWith('s1', undefined, {
        target: {
          kind: 'remote-window',
          target: expect.objectContaining({
            streamTargetId: 'app-1',
          }),
        },
      });
      expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
        path: '/storage/emulated/0/Download/zterm/remote-window-TextEdit.png',
        data: 'cG5n',
      }));
      expect(screen.getByTestId('remote-window-screenshot-status').textContent).toContain('原始截图已保存');
    });
    expect(canvasToDataUrl).not.toHaveBeenCalled();
    canvasToDataUrl.mockRestore();
    expect(onSendRemoteWindowInput).not.toHaveBeenCalled();
  });

  it('loads same-app child thumbnails from remote screenshots without persisting them', async () => {
    vi.mocked(Filesystem.writeFile).mockClear();
    vi.mocked(Filesystem.mkdir).mockClear();
    const session = makeSession('s1');
    const mainTarget = makeTarget();
    const childTarget: RemoteWindowStreamTargetManifest = {
      ...makeTarget(),
      streamTargetId: 'app-child',
      videoTarget: {
        ...mainTarget.videoTarget,
        windowId: 'window-2',
        title: 'TextEdit Preview',
        windowBoundsTopLeftPx: { x: 80, y: 90, width: 300, height: 220 },
        cropRectTopLeftPx: { x: 80, y: 90, width: 300, height: 220 },
      },
    };
    const onRequestRemoteWindowTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [childTarget, mainTarget],
      errors: [],
    }));
    const onRequestRemoteScreenshot = vi.fn(async () => ({
      fileName: 'remote-window-child.png',
      mimeType: 'image/png' as const,
      dataBase64: 'dGh1bWI=',
      totalBytes: 5,
    }));

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
        onRequestRemoteScreenshot={onRequestRemoteScreenshot}
        onRequestRemoteWindowTargets={onRequestRemoteWindowTargets}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-app-group-com-apple-TextEdit-123');
    fireEvent.click(screen.getByTestId('remote-window-app-group-com-apple-TextEdit-123'));

    await waitFor(() => {
      expect(onRequestRemoteScreenshot).toHaveBeenCalledWith('s1', undefined, {
        target: {
          kind: 'remote-window',
          target: expect.objectContaining({ streamTargetId: 'app-child' }),
        },
      });
      expect(screen.getByTestId('remote-window-video-window-thumbnail-app-child')).toBeTruthy();
    });
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
  });

  it('does not route quickbar input through unsupported iTerm pane remote-window targets', async () => {
    const session = makeSession('s1');
    const mediaStream = { id: 'media-stream-1' } as MediaStream;
    const onRequestRemoteWindowTargets = vi.fn(async () => ({
      requestId: 'rw-1',
      targets: [makeItermTarget()],
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
        requestId: 'rw-start-iterm',
        streamId,
        targetId: 'pane-1',
        answer: { type: 'answer' as const, sdp: 'v=0' },
        capture: {
          source: 'ScreenCaptureKit' as const,
          frameWidth: 800,
          frameHeight: 560,
          frameRate: 30,
          targetKind: 'iterm2-pane' as const,
        },
        transport: {
          kind: 'webrtc-video' as const,
        },
      },
    }));
    const onSendRemoteWindowInput = vi.fn();
    const onQuickActionInput = vi.fn();

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
        onRequestRemoteWindowTargets={onRequestRemoteWindowTargets}
        onRequestRemoteWindowStreamStart={onRequestRemoteWindowStreamStart}
        onSendRemoteWindowInput={onSendRemoteWindowInput}
        onQuickActionInput={onQuickActionInput}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '打开远程窗口' }));
    await screen.findByTestId('remote-window-iterm-pane-group');
    fireEvent.click(screen.getByTestId('remote-window-iterm-pane-group'));
    fireEvent.click(screen.getByTestId('remote-window-target-pane-1'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-window-video')).toBeTruthy();
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-remote-window-input-active')).toBe('false');
    });

    fireEvent.click(screen.getByText('quickbar-arrow-up'));
    expect(onSendRemoteWindowInput).not.toHaveBeenCalled();
    expect(onQuickActionInput).toHaveBeenCalledWith('\x1b[A', 's1');
  });
});
