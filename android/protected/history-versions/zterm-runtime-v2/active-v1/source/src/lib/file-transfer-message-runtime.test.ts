// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { createFileTransferMessageRuntime, isFileTransferMessage } from './file-transfer-message-runtime';
import type { ServerMessage } from './types';

describe('file transfer message runtime', () => {
  it('routes remote screenshot lifecycle messages to hooks and listeners', () => {
    const seen: string[] = [];
    const runtime = createFileTransferMessageRuntime({
      onRemoteScreenshotStatus: (payload) => seen.push(`status:${payload.phase}`),
      onRemoteScreenshotChunk: (payload) => seen.push(`chunk:${payload.chunkIndex}`),
      onRemoteScreenshotComplete: (payload) => seen.push(`complete:${payload.fileName}`),
      onRemoteScreenshotError: (payload) => seen.push(`error:${payload.error}`),
    });
    runtime.subscribe((msg) => seen.push(`listener:${msg.type}`));

    runtime.dispatch({
      type: 'remote-screenshot-status',
      payload: { requestId: 'r1', phase: 'capturing' },
    } as ServerMessage & { type: 'remote-screenshot-status' });
    runtime.dispatch({
      type: 'file-download-chunk',
      payload: { requestId: 'r1', chunkIndex: 0, totalChunks: 1, fileName: 'a.png', dataBase64: 'Zm9v' },
    } as ServerMessage & { type: 'file-download-chunk' });
    runtime.dispatch({
      type: 'file-download-complete',
      payload: { requestId: 'r1', fileName: 'a.png', totalBytes: 3 },
    } as ServerMessage & { type: 'file-download-complete' });
    runtime.dispatch({
      type: 'file-download-error',
      payload: { requestId: 'r1', error: 'boom' },
    } as ServerMessage & { type: 'file-download-error' });

    expect(seen).toEqual([
      'status:capturing',
      'listener:remote-screenshot-status',
      'chunk:0',
      'listener:file-download-chunk',
      'complete:a.png',
      'listener:file-download-complete',
      'error:boom',
      'listener:file-download-error',
    ]);
  });

  it('notifies upload and list listeners without screenshot hooks', () => {
    const seen: string[] = [];
    const runtime = createFileTransferMessageRuntime({});
    runtime.subscribe((msg) => seen.push(msg.type));

    runtime.dispatch({
      type: 'file-list-response',
      payload: { requestId: 'l1', path: '/', parentPath: null, entries: [] },
    } as any);
    runtime.dispatch({
      type: 'file-upload-progress',
      payload: { requestId: 'u1', chunkIndex: 0, totalChunks: 2 },
    } as any);

    expect(seen).toEqual(['file-list-response', 'file-upload-progress']);
  });

  it('isolates listener failures and reports them', () => {
    const onListenerError = vi.fn();
    const runtime = createFileTransferMessageRuntime({
      onListenerError,
    });
    runtime.subscribe(() => {
      throw new Error('listener failed');
    });

    runtime.dispatch({
      type: 'file-upload-error',
      payload: { requestId: 'u1', error: 'upload failed' },
    } as any);

    expect(onListenerError).toHaveBeenCalledWith('upload', expect.any(Error));
  });

  it('detects file transfer message set explicitly', () => {
    expect(isFileTransferMessage({
      type: 'file-download-error',
      payload: { requestId: 'r1', error: 'boom' },
    } as any)).toBe(true);
    expect(isFileTransferMessage({
      type: 'buffer-head',
      payload: { sessionId: 's1', revision: 1, latestEndIndex: 1 },
    } as any)).toBe(false);
  });

  it('returns true for handled messages', () => {
    const runtime = createFileTransferMessageRuntime({});
    expect(runtime.dispatch({
      type: 'file-upload-progress',
      payload: { requestId: 'u1', chunkIndex: 0, totalChunks: 2 },
    } as any)).toBe(true);
  });
});
