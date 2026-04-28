// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Directory, Filesystem } from '@capacitor/filesystem';
import type { RemoteScreenshotCapture, Session } from '../lib/types';
import { TerminalPage } from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
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

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({ sessionId }: { sessionId: string }) => <div data-testid={`terminal-view-${sessionId}`} />,
}));

vi.mock('../components/terminal/TerminalQuickBar', () => ({
  TerminalQuickBar: ({
    onRequestRemoteScreenshot,
    remoteScreenshotStatus,
  }: {
    onRequestRemoteScreenshot?: () => void;
    remoteScreenshotStatus?: string;
  }) => (
    <div data-testid="terminal-quickbar" data-remote-screenshot-status={remoteScreenshotStatus || 'idle'}>
      <button type="button" onClick={() => onRequestRemoteScreenshot?.()}>
        request-remote-screenshot
      </button>
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

describe('TerminalPage remote screenshot preview', () => {
  beforeEach(() => {
    vi.stubGlobal('alert', vi.fn());
    vi.stubGlobal('URL', {
      createObjectURL: vi.fn(() => 'blob:remote-shot'),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('shows capturing/transferring states and then opens preview', async () => {
    const session = makeSession('s1');
    const onRequestRemoteScreenshot = vi.fn(async (_sessionId: string, onProgress?: (progress: any) => void): Promise<RemoteScreenshotCapture> => {
      onProgress?.({ requestId: 'rs-1', phase: 'capturing', fileName: 'remote-shot.png' });
      onProgress?.({ requestId: 'rs-1', phase: 'transferring', fileName: 'remote-shot.png', receivedChunks: 1, totalChunks: 2, totalBytes: 6 });
      return {
        fileName: 'remote-shot.png',
        mimeType: 'image/png',
        dataBase64: 'Zm9vYmFy',
        totalBytes: 6,
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
        onRequestRemoteScreenshot={onRequestRemoteScreenshot}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('request-remote-screenshot'));

    await waitFor(() => {
      expect(screen.getByTestId('terminal-quickbar').getAttribute('data-remote-screenshot-status')).toBe('preview-ready');
      expect(screen.getByTestId('remote-screenshot-sheet')).toBeTruthy();
      expect(screen.getByTestId('remote-screenshot-preview-image')).toBeTruthy();
      expect(screen.getByText('截图预览')).toBeTruthy();
      expect(screen.getByTestId('remote-screenshot-step-sent').getAttribute('data-step-status')).toBe('done');
      expect(screen.getByTestId('remote-screenshot-step-captured').getAttribute('data-step-status')).toBe('done');
      expect(screen.getByTestId('remote-screenshot-step-transferred').getAttribute('data-step-status')).toBe('done');
      expect(screen.getByTestId('remote-screenshot-step-displayed').getAttribute('data-step-status')).toBe('done');
    });
  });

  it('saves preview explicitly and allows discard without auto-save', async () => {
    const session = makeSession('s1');
    const onRequestRemoteScreenshot = vi.fn(async (): Promise<RemoteScreenshotCapture> => ({
      fileName: 'remote-shot.png',
      mimeType: 'image/png',
      dataBase64: 'Zm9vYmFy',
      totalBytes: 6,
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
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText('request-remote-screenshot'));

    await waitFor(() => {
      expect(screen.getByTestId('remote-screenshot-preview-image')).toBeTruthy();
    });

    fireEvent.click(screen.getByText('保存到下载'));

    await waitFor(() => {
      expect(Filesystem.mkdir).toHaveBeenCalledWith({
        path: '/storage/emulated/0/Download/zterm',
        directory: Directory.ExternalStorage,
        recursive: true,
      });
      expect(Filesystem.writeFile).toHaveBeenCalledWith({
        path: '/storage/emulated/0/Download/zterm/remote-shot.png',
        data: 'Zm9vYmFy',
        directory: Directory.ExternalStorage,
      });
      expect(screen.queryByTestId('remote-screenshot-sheet')).toBeNull();
    });

    fireEvent.click(screen.getByText('request-remote-screenshot'));
    await waitFor(() => {
      expect(screen.getByTestId('remote-screenshot-preview-image')).toBeTruthy();
    });
    fireEvent.click(screen.getByText('丢弃'));
    await waitFor(() => {
      expect(screen.queryByTestId('remote-screenshot-sheet')).toBeNull();
    });
  });
});
