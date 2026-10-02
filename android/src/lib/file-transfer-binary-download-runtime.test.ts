import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createFileTransferBinaryDownload } from './file-transfer-binary-download-runtime';
import type { FileTransferDownloadStore } from './file-transfer-native-store-port';

describe('file transfer binary download runtime', () => {
  let tmpDir = '';

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'zterm-binary-download-'));
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('only uses HTTP binary download for LAN/Tailscale direct routes', async () => {
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const urlString = input instanceof URL ? input.toString() : input instanceof Request ? input.url : input;
      expect(urlString).toContain('/api/v1/files/download');
      expect(urlString).toContain('path=%2Fremote%2Fphoto.bin');
      expect(urlString).toContain('token=daemon-token');
      return new Response(
        new Blob(['0123456'], { type: 'application/octet-stream' }),
        { status: 200, headers: { 'content-length': '7' } },
      );
    });
    const downloader = createFileTransferBinaryDownload({
      resolvedPath: 'tailscale',
      host: '100.64.0.10',
      port: 3333,
      token: 'daemon-token',
      store: {
        persist: vi.fn(async ({ chunksBase64 }) => {
          expect(chunksBase64).toEqual([Buffer.from('0123456').toString('base64')]);
        }),
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        createDestination: vi.fn(),
      } as FileTransferDownloadStore,
      fetch: fetch as unknown as typeof fetch,
    });
    const destination = {
      requestId: 'req-1',
      scopeId: 'session',
      fileName: 'photo.bin',
      downloadDir: tmpDir,
      targetPath: join(tmpDir, 'photo.bin'),
      stagingPath: join(tmpDir, '.zterm-download-req-1.part'),
    };

    await downloader({
      requestId: 'req-1',
      remotePath: '/remote/photo.bin',
      fileName: 'photo.bin',
      totalBytes: 7,
      destination,
    });

  });

  it('does not fetch through terminal mux for relay-degraded routes', async () => {
    const fetch = vi.fn();
    const downloader = createFileTransferBinaryDownload({
      resolvedPath: 'rtc-relay',
      host: '100.64.0.10',
      port: 3333,
      store: {
        persist: vi.fn(async () => undefined),
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        createDestination: vi.fn(),
      } as FileTransferDownloadStore,
      fetch: fetch as unknown as typeof fetch,
    });

    await expect(downloader({
      requestId: 'req-2',
      remotePath: '/remote/photo.bin',
      fileName: 'photo.bin',
      totalBytes: 7,
      destination: { stagingPath: join(tmpDir, 'ignored.part') } as any,
    })).resolves.toEqual({ bytes: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('passes abort signal and progress to HTTP binary streaming', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      return new Response(new Blob(['12345'], { type: 'application/octet-stream' }), {
        status: 200,
        headers: { 'content-length': '5' },
      });
    });
    const progress: Array<{ receivedBytes: number; expectedBytes: number }> = [];
    const downloader = createFileTransferBinaryDownload({
      resolvedPath: 'lan',
      host: '127.0.0.1',
      port: 3333,
      store: {
        persist: vi.fn(async () => undefined),
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        createDestination: vi.fn(),
      } as FileTransferDownloadStore,
      fetch: fetch as unknown as typeof fetch,
    });

    await downloader({
      requestId: 'req-progress',
      remotePath: '/remote/photo.bin',
      fileName: 'photo.bin',
      totalBytes: 5,
      destination: { stagingPath: join(tmpDir, 'progress.part') } as any,
      signal: controller.signal,
      onProgress: ({ receivedBytes, expectedBytes }) => {
        progress.push({ receivedBytes, expectedBytes });
      },
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(progress).toEqual([{ receivedBytes: 5, expectedBytes: 5 }]);
  });

  it('fails closed before persistence when binary download is aborted', async () => {
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      return new Response(new Blob(['12345'], { type: 'application/octet-stream' }), {
        status: 200,
        headers: { 'content-length': '5' },
      });
    });
    const persist = vi.fn(async () => undefined);
    const downloader = createFileTransferBinaryDownload({
      resolvedPath: 'lan',
      host: '127.0.0.1',
      port: 3333,
      store: {
        persist,
        complete: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        createDestination: vi.fn(),
      } as FileTransferDownloadStore,
      fetch: fetch as unknown as typeof fetch,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(downloader({
      requestId: 'req-abort',
      remotePath: '/remote/photo.bin',
      fileName: 'photo.bin',
      totalBytes: 5,
      destination: { stagingPath: join(tmpDir, 'abort.part') } as any,
      signal: controller.signal,
    })).rejects.toThrow(/aborted/i);
    expect(fetch).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });
});
