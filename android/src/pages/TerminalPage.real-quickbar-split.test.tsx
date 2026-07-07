// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Session, type TerminalViewportChangeHandler } from '../lib/types';
import { TerminalPage } from './TerminalPage';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => 'web',
    isNativePlatform: () => false,
  },
  registerPlugin: () => ({
    readText: vi.fn(async () => ({ value: '' })),
  }),
}));

vi.mock('@capacitor/keyboard', () => ({
  Keyboard: {
    addListener: vi.fn(async () => ({ remove: vi.fn() })),
    hide: vi.fn(async () => undefined),
    show: vi.fn(async () => undefined),
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

vi.mock('../plugins/DeviceClipboardPlugin', () => ({
  DeviceClipboardPlugin: {
    readText: vi.fn(async () => ({ value: '' })),
  },
  isNativeClipboardSupported: () => false,
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

vi.mock('../components/terminal/RemoteScreenshotSheet', () => ({
  RemoteScreenshotSheet: () => null,
}));

vi.mock('../components/TerminalView', () => ({
  TerminalView: ({
    sessionId,
    active,
    live,
    onViewportChange,
  }: {
    sessionId: string;
    active?: boolean;
    live?: boolean;
    onViewportChange?: TerminalViewportChangeHandler;
  }) => (
    <div
      data-testid={`terminal-view-${sessionId}`}
      data-active={active ? 'true' : 'false'}
      data-live={live ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => onViewportChange?.(sessionId, {
          mode: 'follow',
          viewportEndIndex: 120,
          viewportRows: 24,
        })}
      >
        viewport-{sessionId}
      </button>
    </div>
  ),
}));

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function stubVisualViewport(width: number, height: number) {
  Object.defineProperty(window, 'visualViewport', {
    configurable: true,
    writable: true,
    value: {
      width,
      height,
      offsetTop: 0,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } satisfies Partial<VisualViewport>,
  });
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: width,
  });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height,
  });
  stubVisualViewport(width, height);
}

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

describe('TerminalPage real quickbar split integration', () => {
  beforeEach(() => {
    cleanup();
    const storageBacking = new Map<string, string>();
    const storageShim = {
      get length() {
        return storageBacking.size;
      },
      clear() {
        storageBacking.clear();
      },
      getItem(key: string) {
        return storageBacking.has(key) ? storageBacking.get(key)! : null;
      },
      key(index: number) {
        return Array.from(storageBacking.keys())[index] ?? null;
      },
      removeItem(key: string) {
        storageBacking.delete(key);
      },
      setItem(key: string, value: string) {
        storageBacking.set(key, String(value));
      },
    } as Storage;
    vi.stubGlobal('localStorage', storageShim);
    vi.stubGlobal('ResizeObserver', ResizeObserverMock);
    localStorage.clear();
    if (!HTMLElement.prototype.setPointerCapture) {
      HTMLElement.prototype.setPointerCapture = () => {};
    }
    if (!HTMLElement.prototype.releasePointerCapture) {
      HTMLElement.prototype.releasePointerCapture = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('opens split from the real floating quickbar menu when viewport satisfies the split gate', async () => {
    setViewport(800, 844);
    const sessions = [makeSession('s1'), makeSession('s2')];

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));
    fireEvent.click(screen.getByRole('button', { name: '2 分屏' }));

    await waitFor(() => {
      expect(screen.getAllByTestId('terminal-pane-shell')).toHaveLength(2);
    });
  });

  it('shows four-pane choice when landscape layout already qualifies for three panes', async () => {
    setViewport(1200, 900);
    const sessions = [makeSession('s1'), makeSession('s2'), makeSession('s3'), makeSession('s4')];

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));

    expect(screen.getByRole('button', { name: '3 分屏' })).not.toBeNull();
    expect(screen.getByRole('button', { name: '4 分屏' })).not.toBeNull();
  });

  it('hides split actions on a narrow phone viewport below the split gate', async () => {
    setViewport(320, 800);
    const sessions = [makeSession('s1'), makeSession('s2')];

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Toggle floating quick menu' }));

    expect(screen.queryByRole('button', { name: '2 分屏' })).toBeNull();
  });

  it('routes image and file buttons through the real terminal page quickbar path', async () => {
    setViewport(390, 844);
    const sessions = [makeSession('s1')];
    const onImagePaste = vi.fn();
    const onFileAttach = vi.fn();

    render(
      <TerminalPage
        sessions={sessions}
        activeSession={sessions[0]}
        onSwitchSession={vi.fn()}
        onMoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenConnections={vi.fn()}
        onOpenQuickTabPicker={vi.fn()}
        onResize={vi.fn()}
        onTerminalInput={vi.fn()}
        onTerminalViewportChange={vi.fn()}
        onImagePaste={onImagePaste}
        onFileAttach={onFileAttach}
        quickActions={[]}
        shortcutActions={[]}
        sessionDraft=""
        onLoadSavedTabList={vi.fn()}
      />,
    );

    const inputs = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    );
    const imageInput = inputs.find((input) => input.accept === 'image/*');
    const fileInput = inputs.find((input) => input.accept !== 'image/*');
    expect(imageInput).toBeTruthy();
    expect(fileInput).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '图片' }));
    fireEvent.change(imageInput!, {
      target: {
        files: [new File(['image'], 'proof.png', { type: 'image/png' })],
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '文件' }));
    fireEvent.change(fileInput!, {
      target: {
        files: [new File(['archive'], 'archive.zip', { type: 'application/zip' })],
      },
    });

    await waitFor(() => {
      expect(onImagePaste).toHaveBeenCalledWith('s1', expect.any(File));
      expect(onFileAttach).toHaveBeenCalledWith('s1', expect.any(File));
    });
  });
});
