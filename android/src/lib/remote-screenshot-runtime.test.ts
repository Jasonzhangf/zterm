// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type {
  FileDownloadChunkPayload,
  FileDownloadCompletePayload,
  FileDownloadErrorPayload,
  RemoteScreenshotStatusPayload,
} from './types';
import { createRemoteScreenshotRuntime } from './remote-screenshot-runtime';

function createMockSocket() {
  return { readyState: WebSocket.OPEN } as any;
}

describe('remote screenshot runtime', () => {
  it('streams status and chunks into final screenshot capture', async () => {
    const runtime = createRemoteScreenshotRuntime({
      now: () => 123,
    });
    const sent: any[] = [];
    const progress: string[] = [];

    const promise = runtime.request('session-1', {
      ws: createMockSocket(),
      onProgress: (payload) => {
        progress.push(`${payload.phase}:${payload.receivedChunks || 0}/${payload.totalChunks || 0}`);
      },
      sendSocketPayload: (_sessionId, _ws, data) => {
        sent.push(JSON.parse(String(data)));
      },
    });

    const requestId = sent[0]?.payload?.requestId;
    expect(requestId).toBe('rs-123-' + String(requestId).slice(7));

    runtime.handleStatus({
      requestId,
      phase: 'capturing',
      fileName: 'shot.png',
    } satisfies RemoteScreenshotStatusPayload);
    runtime.handleStatus({
      requestId,
      phase: 'transferring',
      fileName: 'shot.png',
      receivedChunks: 0,
      totalChunks: 2,
      totalBytes: 6,
    } satisfies RemoteScreenshotStatusPayload);
    runtime.handleChunk({
      requestId,
      chunkIndex: 1,
      totalChunks: 2,
      fileName: 'shot.png',
      dataBase64: 'YmFy',
    } satisfies FileDownloadChunkPayload);
    runtime.handleChunk({
      requestId,
      chunkIndex: 0,
      totalChunks: 2,
      fileName: 'shot.png',
      dataBase64: 'Zm9v',
    } satisfies FileDownloadChunkPayload);
    runtime.handleComplete({
      requestId,
      fileName: 'shot.png',
      totalBytes: 6,
    } satisfies FileDownloadCompletePayload);

    await expect(promise).resolves.toMatchObject({
      fileName: 'shot.png',
      dataBase64: 'Zm9vYmFy',
      totalBytes: 6,
    });
    expect(progress[progress.length - 1]).toBe('transferring:2/2');
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('fails explicitly on timeout', async () => {
    let timeoutHandler: (() => void) | null = null;
    const runtime = createRemoteScreenshotRuntime({
      setTimeoutFn: (((handler: TimerHandler) => {
        timeoutHandler = handler as () => void;
        return 9 as unknown as number;
      }) as unknown) as typeof window.setTimeout,
      clearTimeoutFn: vi.fn() as any,
      now: () => 456,
    });

    const promise = runtime.request('session-1', {
      ws: createMockSocket(),
      sendSocketPayload: () => undefined,
    });

    expect(timeoutHandler).not.toBeNull();
    const fireTimeout = timeoutHandler!;
    fireTimeout();

    await expect(promise).rejects.toThrow('Remote screenshot timed out during request-sent');
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('fails explicitly on remote download error', async () => {
    const runtime = createRemoteScreenshotRuntime({
      now: () => 789,
    });

    const sent: any[] = [];
    const promise = runtime.request('session-1', {
      ws: createMockSocket(),
      sendSocketPayload: (_sessionId, _ws, data) => {
        sent.push(JSON.parse(String(data)));
      },
    });

    const requestId = sent[0]?.payload?.requestId;
    runtime.handleError({
      requestId,
      error: 'download failed',
    } satisfies FileDownloadErrorPayload);

    await expect(promise).rejects.toThrow('download failed');
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('rejects all pending requests on dispose', async () => {
    const runtime = createRemoteScreenshotRuntime({
      now: () => 999,
    });

    const promise = runtime.request('session-1', {
      ws: createMockSocket(),
      sendSocketPayload: () => undefined,
    });
    runtime.dispose('disposed');
    await expect(promise).rejects.toThrow('disposed');
    expect(runtime.getPendingCount()).toBe(0);
  });

  it('cleans pending request immediately when sendSocketPayload throws', async () => {
    const clearTimeoutFn = vi.fn();
    const runtime = createRemoteScreenshotRuntime({
      clearTimeoutFn: clearTimeoutFn as any,
      now: () => 1000,
    });

    const promise = runtime.request('session-1', {
      ws: createMockSocket(),
      sendSocketPayload: () => {
        throw new Error('send failed');
      },
    });

    await expect(promise).rejects.toThrow('send failed');
    expect(runtime.getPendingCount()).toBe(0);
    expect(clearTimeoutFn).toHaveBeenCalled();
  });
});
