import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalFileTransferListRuntime } from './terminal-file-transfer-list-runtime';
import { createTerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import type { ServerMessage } from '../lib/types';
import type { TerminalSession } from './terminal-runtime-types';
import type { RemoteScreenshotCaptureOptions } from './terminal-file-transfer-types';

function makeSession(overrides?: Partial<Pick<TerminalSession, 'backend'>>): TerminalSession {
  return {
    id: 'session-1',
    transportId: 'transport-1',
    transport: null,
    sessionName: 'client-session-name',
    mirrorKey: 'mirror-1',
    pendingPasteImage: null,
    pendingAttachFile: null,
    ...overrides,
  };
}

function makeTarget(overrides?: { kind?: 'app-window' | 'iterm2-pane'; windowId?: string }) {
  const kind = overrides?.kind || 'app-window';
  return {
    streamTargetId: kind === 'app-window' ? 'app-1' : 'pane-1',
    videoTarget: {
      kind,
      appBundleId: kind === 'app-window' ? 'com.apple.TextEdit' : 'com.googlecode.iterm2',
      pid: 123,
      windowId: overrides?.windowId || '42',
      title: kind === 'app-window' ? 'TextEdit' : 'zterm pane',
      windowBoundsTopLeftPx: { x: 10, y: 20, width: 800, height: 600 },
      ...(kind === 'iterm2-pane'
        ? { cropRectTopLeftPx: { x: 20, y: 80, width: 500, height: 320 } }
        : {}),
    },
    inputTarget: { kind: kind === 'app-window' ? 'app-window' : 'tmux-pane' },
    streamMode: kind === 'app-window' ? 'interactive' : 'view',
    focusPolicy: kind === 'app-window' ? 'bring-to-focus' : 'no-focus-steal',
    inputRoute: kind === 'app-window' ? 'os-event' : 'tmux-input',
    capture: {
      source: 'ScreenCaptureKit',
      coordinateSpace: 'macos-top-left-px',
      scale: 1,
      createdAt: '2026-07-22T00:00:00.000Z',
    },
  } as const;
}

async function flushFileTransferMessages() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setImmediate(resolve));
}

describe('terminal-file-transfer-list-runtime remote screenshot target capture', () => {
  let tempDir: string | null = null;
  const createdRuntimes: Array<{ dispose?: () => void }> = [];

  afterEach(() => {
    for (const runtime of createdRuntimes.splice(0)) {
      runtime.dispose?.();
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  function createRuntime(sentMessages: ServerMessage[], captureRemoteScreenshot = vi.fn(async ({ outputPath }: RemoteScreenshotCaptureOptions) => {
    writeFileSync(outputPath, Buffer.from('png'));
    return { outputPath };
  })) {
    tempDir = mkdtempSync(join(tmpdir(), 'zterm-shot-'));
    const runtime = createTerminalFileTransferListRuntime({
        uploadDir: tempDir,
        downloadsDir: tempDir,
        wtermHomeDir: tempDir,
        platform: 'darwin',
        sendMessage: (_session, message) => sentMessages.push(message),
        getSessionMirror: vi.fn(() => null),
        scheduleMirrorLiveSync: vi.fn(),
        writeToTmuxSession: vi.fn(),
        writeToLiveMirror: vi.fn(() => false),
        readTmuxPaneCurrentPath: vi.fn(() => tempDir!),
        runCommand: vi.fn(),
        captureRemoteScreenshot,
        logTimePrefix: () => '2026-07-22 00:00:00',
      });
    createdRuntimes.push(runtime);
    return {
      runtime,
      captureRemoteScreenshot,
    };
  }

  it('serves repeated remote directory requests from daemon cache until the watcher refreshes it', async () => {
    const sentMessages: ServerMessage[] = [];
    const { runtime } = createRuntime(sentMessages);
    writeFileSync(join(tempDir!, 'old.txt'), 'old');

    runtime.handleFileListRequest(makeSession(), {
      requestId: 'list-1',
      path: tempDir!,
      showHidden: true,
    });

    expect(sentMessages[sentMessages.length - 1]).toMatchObject({
      type: 'file-list-response',
      payload: {
        requestId: 'list-1',
        entries: [expect.objectContaining({ name: 'old.txt' })],
      },
    });

    writeFileSync(join(tempDir!, 'fresh.txt'), 'fresh');
    runtime.handleFileListRequest(makeSession(), {
      requestId: 'list-2',
      path: tempDir!,
      showHidden: true,
    });

    expect(
      (sentMessages[sentMessages.length - 1] as any).payload.entries.map((entry: { name: string }) => entry.name),
    ).toEqual(['old.txt']);

    await new Promise((resolve) => setTimeout(resolve, 150));
    runtime.handleFileListRequest(makeSession(), {
      requestId: 'list-3',
      path: tempDir!,
      showHidden: true,
    });

    expect(
      (sentMessages[sentMessages.length - 1] as any).payload.entries.map((entry: { name: string }) => entry.name),
    ).toEqual(['fresh.txt', 'old.txt']);
  });

  it('does not retain stale remote directory cache when watcher creation fails', async () => {
    vi.resetModules();
    vi.doMock('fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('fs')>();
      return {
        ...actual,
        watch: vi.fn(() => {
          throw new Error('watch unavailable');
        }),
      };
    });
    try {
      const { createTerminalFileTransferListRuntime: createRuntimeWithFailingWatch } =
        await import('./terminal-file-transfer-list-runtime');
      const sentMessages: ServerMessage[] = [];
      tempDir = mkdtempSync(join(tmpdir(), 'zterm-shot-'));
      writeFileSync(join(tempDir, 'old.txt'), 'old');
      const runtime = createRuntimeWithFailingWatch({
        uploadDir: tempDir,
        downloadsDir: tempDir,
        wtermHomeDir: tempDir,
        platform: 'darwin',
        sendMessage: (_session, message) => sentMessages.push(message),
        getSessionMirror: vi.fn(() => null),
        scheduleMirrorLiveSync: vi.fn(),
        writeToTmuxSession: vi.fn(),
        writeToLiveMirror: vi.fn(() => false),
        readTmuxPaneCurrentPath: vi.fn(() => tempDir!),
        runCommand: vi.fn(),
        captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
        logTimePrefix: () => '2026-07-22 00:00:00',
      });
      createdRuntimes.push(runtime);

      runtime.handleFileListRequest(makeSession(), {
        requestId: 'list-1',
        path: tempDir,
        showHidden: true,
      });
      writeFileSync(join(tempDir, 'fresh.txt'), 'fresh');
      runtime.handleFileListRequest(makeSession(), {
        requestId: 'list-2',
        path: tempDir,
        showHidden: true,
      });

      expect(
        (sentMessages[sentMessages.length - 1] as any).payload.entries.map((entry: { name: string }) => entry.name),
      ).toEqual(['fresh.txt', 'old.txt']);
    } finally {
      vi.doUnmock('fs');
      vi.resetModules();
    }
  });

  it('refreshes a cached remote directory immediately after upload completion', () => {
    const sentMessages: ServerMessage[] = [];
    tempDir = mkdtempSync(join(tmpdir(), 'zterm-shot-'));
    writeFileSync(join(tempDir, 'old.txt'), 'old');
    const runtime = createTerminalFileTransferRuntime({
      uploadDir: tempDir,
      downloadsDir: tempDir,
      wtermHomeDir: tempDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: vi.fn(() => null),
      scheduleMirrorLiveSync: vi.fn(),
      writeToTmuxSession: vi.fn(),
      writeToLiveMirror: vi.fn(() => false),
      readTmuxPaneCurrentPath: vi.fn(() => tempDir!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-22 00:00:00',
    });
    createdRuntimes.push(runtime);
    const session = makeSession();

    runtime.handleFileListRequest(session, {
      requestId: 'list-before-upload',
      path: tempDir,
      showHidden: true,
    });
    runtime.handleFileUploadStart(session, {
      requestId: 'upload-1',
      targetDir: tempDir,
      fileName: 'fresh.txt',
      fileSize: 5,
      chunkCount: 1,
    });
    runtime.handleFileUploadChunk(session, {
      requestId: 'upload-1',
      chunkIndex: 0,
      dataBase64: Buffer.from('fresh').toString('base64'),
    });
    runtime.handleFileUploadEnd(session, { requestId: 'upload-1' });
    runtime.handleFileListRequest(session, {
      requestId: 'list-after-upload',
      path: tempDir,
      showHidden: true,
    });

    expect(
      (sentMessages[sentMessages.length - 1] as any).payload.entries.map((entry: { name: string }) => entry.name),
    ).toEqual(['fresh.txt', 'old.txt']);
  });

  it('captures a selected app-window screenshot by macOS window id without focusing input', async () => {
    const sentMessages: ServerMessage[] = [];
    const { runtime, captureRemoteScreenshot } = createRuntime(sentMessages);

    await runtime.handleRemoteScreenshotRequest(makeSession(), {
      requestId: 'rs-1',
      target: {
        kind: 'remote-window',
        target: makeTarget({ kind: 'app-window', windowId: '42' }) as any,
      },
    });
    await flushFileTransferMessages();

    expect(captureRemoteScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      windowId: '42',
    }));
    expect(captureRemoteScreenshot.mock.calls[0][0]).not.toHaveProperty('rect');
    expect(sentMessages.map((message) => message.type)).toContain('remote-screenshot-status');
    expect(sentMessages.map((message) => message.type)).toContain('file-download-complete');
  });

  it('captures a selected iTerm pane screenshot by the normalized crop rectangle', async () => {
    const sentMessages: ServerMessage[] = [];
    const { runtime, captureRemoteScreenshot } = createRuntime(sentMessages);

    await runtime.handleRemoteScreenshotRequest(makeSession(), {
      requestId: 'rs-2',
      target: {
        kind: 'remote-window',
        target: makeTarget({ kind: 'iterm2-pane', windowId: '42' }) as any,
      },
    });
    await flushFileTransferMessages();

    expect(captureRemoteScreenshot).toHaveBeenCalledWith(expect.objectContaining({
      rect: { x: 20, y: 80, width: 500, height: 320 },
    }));
    expect(captureRemoteScreenshot.mock.calls[0][0]).not.toHaveProperty('windowId');
  });

  it('rejects invalid remote-window screenshot targets instead of falling back to a full screenshot', async () => {
    const sentMessages: ServerMessage[] = [];
    const { runtime, captureRemoteScreenshot } = createRuntime(sentMessages);

    await runtime.handleRemoteScreenshotRequest(makeSession(), {
      requestId: 'rs-3',
      target: {
        kind: 'remote-window',
        target: makeTarget({ kind: 'app-window', windowId: 'not-numeric' }) as any,
      },
    });

    expect(captureRemoteScreenshot).not.toHaveBeenCalled();
    expect(sentMessages).toContainEqual({
      type: 'file-download-error',
      payload: {
        requestId: 'rs-3',
        error: 'remote window screenshot requires a numeric macOS window id',
      },
    });
  });

  it('rejects all file-transfer operations explicitly for a Herdr terminal surface', async () => {
    const sentMessages: ServerMessage[] = [];
    tempDir = mkdtempSync(join(tmpdir(), 'zterm-herdr-file-transfer-'));
    const writeToTmuxSession = vi.fn();
    const runtime = createTerminalFileTransferRuntime({
      uploadDir: tempDir,
      downloadsDir: tempDir,
      wtermHomeDir: tempDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: vi.fn(() => null),
      scheduleMirrorLiveSync: vi.fn(),
      writeToTmuxSession,
      writeToLiveMirror: vi.fn(() => false),
      readTmuxPaneCurrentPath: vi.fn(() => tempDir!),
      runCommand: vi.fn(),
      captureRemoteScreenshot: vi.fn(async ({ outputPath }) => ({ outputPath })),
      logTimePrefix: () => '2026-07-22 00:00:00',
    });
    createdRuntimes.push(runtime);

    const session = makeSession({ backend: 'herdr' });
    runtime.handleFileListRequest(session, {
      requestId: 'herdr-list', path: tempDir, showHidden: true,
    });
    await runtime.handleRemoteScreenshotRequest(session, { requestId: 'herdr-shot' });
    runtime.handlePasteImage(session, {
      name: 'proof.png', mimeType: 'image/png', dataBase64: 'cHJvb2Y=',
    });

    expect(writeToTmuxSession).not.toHaveBeenCalled();
    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.every((message) => (
      message.type === 'error'
      && message.payload.code === 'herdr_file_transfer_unsupported'
    ))).toBe(true);
  });
});
