import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTerminalFileTransferListRuntime } from './terminal-file-transfer-list-runtime';
import { createTerminalFileTransferRuntime } from './terminal-file-transfer-runtime';
import type { ServerMessage } from '../lib/types';
import type { TerminalSession } from './terminal-runtime-types';
import { FILE_CHUNK_SIZE, type RemoteScreenshotCaptureOptions } from './terminal-file-transfer-types';

const { browseGateMock, downloadGateMock, uploadGateMock } = vi.hoisted(() => ({
  browseGateMock: vi.fn(() => ({ ok: true, outputs: {} })),
  downloadGateMock: vi.fn(() => ({ ok: true, outputs: {} })),
  uploadGateMock: vi.fn(() => ({ ok: true, outputs: {} })),
}));

vi.mock('./dagpipe-bridge', () => ({
  runPhase3FileBrowse: browseGateMock,
  runPhase3Download: downloadGateMock,
  runPhase3Upload: uploadGateMock,
}));

function makeSession(overrides?: Partial<Pick<TerminalSession, 'backend'>>): TerminalSession {
  return {
    id: 'session-1',
    transportId: 'transport-1',
    transport: {
      kind: 'ws',
      readyState: 1,
      bufferedAmount: 0,
      backpressureCount: 0,
      sendText: () => undefined,
      close: () => undefined,
    },
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

  function createRuntime(
    sentMessages: ServerMessage[],
    captureRemoteScreenshot = vi.fn(async ({ outputPath }: RemoteScreenshotCaptureOptions) => {
      writeFileSync(outputPath, Buffer.from('png'));
      return { outputPath };
    }),
    sendMessageOverride?: (session: TerminalSession, message: ServerMessage) => void,
  ) {
    tempDir = mkdtempSync(join(tmpdir(), 'zterm-shot-'));
    const runtime = createTerminalFileTransferListRuntime({
        uploadDir: tempDir,
        downloadsDir: tempDir,
        wtermHomeDir: tempDir,
        platform: 'darwin',
        sendMessage: sendMessageOverride ?? ((_session, message) => sentMessages.push(message)),
        getSessionMirror: vi.fn(() => null),
        scheduleMirrorLiveSync: vi.fn(),
        enqueueBackendInput: vi.fn(async () => false),
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

    // Drive the refresh explicitly: the runtime refreshes the cache either via
    // the filesystem watcher or this exposed callback. The test must not depend
    // on watcher timing inside jsdom, so call the same refresh the watcher
    // would trigger and then assert list-3 sees the new directory state.
    runtime.refreshDirectoryCache(tempDir!);
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
        enqueueBackendInput: vi.fn(async () => false),
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
      enqueueBackendInput: vi.fn(async () => false),
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

  it('rejects file list when the Phase3 browse gate fails', () => {
    browseGateMock.mockReturnValueOnce({ ok: false, error: 'file browse denied by permission policy' } as any);
    const sentMessages: ServerMessage[] = [];
    const { runtime } = createRuntime(sentMessages);

    runtime.handleFileListRequest(makeSession(), {
      requestId: 'list-gate',
      path: tempDir!,
      showHidden: true,
    });

    expect(sentMessages[sentMessages.length - 1]).toMatchObject({
      type: 'file-list-error',
      payload: {
        requestId: 'list-gate',
        error: expect.stringContaining('dagpipe_file_browse_rejected'),
      },
    });
  });

  it('resolves an empty-path file list request to the tmux pane cwd before the Phase3 browse gate', () => {
    browseGateMock.mockClear();
    const sentMessages: ServerMessage[] = [];
    const { runtime } = createRuntime(sentMessages);

    runtime.handleFileListRequest(makeSession(), {
      requestId: 'list-empty-path',
      path: '',
      showHidden: true,
    });

    expect(browseGateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inputs: expect.objectContaining({
          'arc.file_browse_request': { path: tempDir! },
        }),
      }),
    );
    expect(sentMessages[sentMessages.length - 1]).toMatchObject({
      type: 'file-list-response',
      payload: { requestId: 'list-empty-path', path: tempDir! },
    });
  });

  it('rejects file download when the Phase3 download gate fails', () => {
    downloadGateMock.mockReturnValueOnce({ ok: false, error: 'download denied by transfer policy' } as any);
    const sentMessages: ServerMessage[] = [];
    const { runtime } = createRuntime(sentMessages);

    runtime.handleFileDownloadRequest(makeSession(), {
      requestId: 'download-gate',
      remotePath: join(tempDir!, 'missing.txt'),
      fileName: 'missing.txt',
      totalBytes: 0,
    });

    expect(sentMessages[sentMessages.length - 1]).toMatchObject({
      type: 'file-download-error',
      payload: {
        requestId: 'download-gate',
        error: expect.stringContaining('dagpipe_file_download_rejected'),
      },
    });
  });

  it('rejects all file-transfer operations explicitly for a Herdr terminal surface', async () => {
    const sentMessages: ServerMessage[] = [];
    tempDir = mkdtempSync(join(tmpdir(), 'zterm-herdr-file-transfer-'));
    const runtime = createTerminalFileTransferRuntime({
      uploadDir: tempDir,
      downloadsDir: tempDir,
      wtermHomeDir: tempDir,
      platform: 'darwin',
      sendMessage: (_session, message) => sentMessages.push(message),
      getSessionMirror: vi.fn(() => null),
      scheduleMirrorLiveSync: vi.fn(),
      enqueueBackendInput: vi.fn(async () => false),
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

    expect(sentMessages).toHaveLength(3);
    expect(sentMessages.every((message) => (
      message.type === 'error'
      && message.payload.code === 'herdr_file_transfer_unsupported'
    ))).toBe(true);
  });

  it('paces file download chunks on physical transport backpressure', async () => {
    const sentMessages: ServerMessage[] = [];
    const transport = {
      kind: 'ws' as const,
      readyState: 1,
      bufferedAmount: 0,
      backpressureCount: 0,
      sendText: () => undefined,
      close: () => undefined,
    };
    const session = makeSession();
    session.transport = transport;
    let chunkCount = 0;
    const { runtime } = createRuntime(sentMessages, undefined, (_session, message) => {
      sentMessages.push(message);
      if (message.type === 'file-download-chunk') {
        chunkCount += 1;
        if (chunkCount === 2) {
          transport.bufferedAmount = 200_000;
        }
      }
    });
    writeFileSync(join(tempDir!, 'paced.bin'), Buffer.alloc(FILE_CHUNK_SIZE * 2 + 1, 0x41));

    runtime.handleFileDownloadRequest(session, {
      requestId: 'download-paced',
      remotePath: join(tempDir!, 'paced.bin'),
      fileName: 'paced.bin',
      totalBytes: FILE_CHUNK_SIZE * 2 + 1,
    });
    await flushFileTransferMessages();

    expect(chunkCount).toBe(2);

    transport.bufferedAmount = 200_000;
    await flushFileTransferMessages();
    expect(chunkCount).toBe(2);
    expect(sentMessages.some((message) => message.type === 'file-download-complete')).toBe(false);

    transport.bufferedAmount = 0;
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushFileTransferMessages();
    expect(chunkCount).toBe(3);
    expect(sentMessages.some((message) => message.type === 'file-download-complete')).toBe(true);
  });

  it('stops a file download and does not send complete when transport retires mid-flight', async () => {
    const sentMessages: ServerMessage[] = [];
    const transport = {
      kind: 'ws' as const,
      readyState: 1,
      bufferedAmount: 0,
      backpressureCount: 0,
      sendText: () => undefined,
      close: () => undefined,
    };
    const session = makeSession();
    session.transport = transport;
    let chunkCount = 0;
    const { runtime } = createRuntime(sentMessages, undefined, (_session, message) => {
      sentMessages.push(message);
      if (message.type === 'file-download-chunk') {
        chunkCount += 1;
        if (chunkCount === 1) {
          session.transportId = 'transport-2';
        }
      }
    });
    writeFileSync(join(tempDir!, 'retired.bin'), Buffer.alloc(FILE_CHUNK_SIZE * 3, 0x42));

    runtime.handleFileDownloadRequest(session, {
      requestId: 'download-retired',
      remotePath: join(tempDir!, 'retired.bin'),
      fileName: 'retired.bin',
      totalBytes: FILE_CHUNK_SIZE * 3,
    });
    await flushFileTransferMessages();

    session.transportId = 'transport-2';
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushFileTransferMessages();

    expect(chunkCount).toBe(1);
    expect(sentMessages.some((message) => message.type === 'file-download-complete')).toBe(false);
    expect(sentMessages.some((message) => message.type === 'file-download-error')).toBe(false);
  });

  it('holds the first chunk while the transport flow observation is unknown', async () => {
    const sentMessages: ServerMessage[] = [];
    const transport = {
      kind: 'ws' as const,
      readyState: 1,
      bufferedAmount: 0,
      flowUnknown: true,
      sendText: () => undefined,
      close: () => undefined,
    };
    const session = makeSession();
    session.transport = transport;
    let chunkCount = 0;
    const { runtime } = createRuntime(sentMessages, undefined, (_session, message) => {
      sentMessages.push(message);
      if (message.type === 'file-download-chunk') {
        chunkCount += 1;
      }
    });
    writeFileSync(join(tempDir!, 'unknown-flow.bin'), Buffer.alloc(FILE_CHUNK_SIZE * 2, 0x43));

    runtime.handleFileDownloadRequest(session, {
      requestId: 'download-unknown-flow',
      remotePath: join(tempDir!, 'unknown-flow.bin'),
      fileName: 'unknown-flow.bin',
      totalBytes: FILE_CHUNK_SIZE * 2,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await flushFileTransferMessages();

    expect(chunkCount).toBe(0);
    expect(sentMessages.some((message) => message.type === 'file-download-complete')).toBe(false);

    transport.flowUnknown = false;
    await new Promise((resolve) => setTimeout(resolve, 40));
    await flushFileTransferMessages();
    expect(chunkCount).toBe(2);
    expect(sentMessages.some((message) => message.type === 'file-download-complete')).toBe(true);
  });
});
