import { describe, expect, it, vi } from 'vitest';
import { createFileTransferSessionRuntime } from './file-transfer-session-runtime';

describe('file-transfer-session-runtime', () => {
  it('owns remote list request/response truth', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 100,
      randomId: () => 'abcd',
    });

    runtime.open('/remote/home');
    const request = runtime.requestRemoteList('/remote/home', false);

    expect(runtime.getState().remoteLoading).toBe(true);
    expect(request.message.payload.requestId).toBe('flist-100-abcd');

    await runtime.applyMessage({
      type: 'file-list-response',
      payload: {
        requestId: 'flist-100-abcd',
        path: '/remote/home',
        parentPath: '/remote',
        entries: [{ name: 'a.txt', type: 'file', size: 12, modified: 1 }],
      },
    });

    expect(runtime.getState().remoteLoading).toBe(false);
    expect(runtime.getState().remoteEntries).toHaveLength(1);
    expect(runtime.getState().remoteParentPath).toBe('/remote');
  });

  it('owns download chunk -> complete transfer progression', async () => {
    const onDownloadComplete = vi.fn();
    const runtime = createFileTransferSessionRuntime({
      now: () => 200,
      randomId: () => 'wxyz',
      onDownloadComplete,
    });

    runtime.open('/remote/home');
    const download = runtime.startDownload({ name: 'b.txt', size: 4096 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: download.requestId,
        fileName: 'b.txt',
        chunkIndex: 0,
        totalChunks: 2,
        dataBase64: 'Zm9v',
      },
    });

    expect(runtime.getState().transfers[0]?.transferredBytes).toBe(1);

    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: download.requestId,
        fileName: 'b.txt',
        totalBytes: 4096,
      },
    });

    expect(onDownloadComplete).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: download.requestId }),
      ['Zm9v'],
    );
    expect(runtime.getState().transfers[0]?.status).toBe('done');
    expect(runtime.getState().transfers[0]?.transferredBytes).toBe(4096);
  });

  it('keeps download transfer in error state when local write callback fails', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 250,
      randomId: () => 'fail',
      onDownloadComplete: () => {
        throw new Error('download size mismatch: wrote 0 bytes, expected 5');
      },
    });

    runtime.open('/remote/home');
    const download = runtime.startDownload({ name: 'photo.png', size: 5 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: download.requestId,
        fileName: 'photo.png',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: 'aW1hZ2U=',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: download.requestId,
        fileName: 'photo.png',
        totalBytes: 5,
      },
    });

    expect(runtime.getState().transfers[0]).toMatchObject({
      status: 'error',
      error: 'download size mismatch: wrote 0 bytes, expected 5',
    });
  });

  it('owns upload runtime truth independently from component state', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 300,
      randomId: () => 'zzzz',
    });

    runtime.open('/remote/home');
    const upload = runtime.startUpload({ name: 'c.txt', size: 8192 }, '/remote/home', 3);

    expect(upload.startMessage.payload.requestId).toBe('ful-300-zzzz');
    expect(runtime.getState().transfers[0]?.status).toBe('transferring');

    await runtime.applyMessage({
      type: 'file-upload-progress',
      payload: {
        requestId: upload.requestId,
        chunkIndex: 2,
        totalChunks: 3,
      },
    });
    expect(runtime.getState().transfers[0]?.transferredBytes).toBe(2);

    await runtime.applyMessage({
      type: 'file-upload-complete',
      payload: { requestId: upload.requestId, filePath: '/remote/home/c.txt', bytes: 8192 },
    });
    expect(runtime.getState().transfers[0]?.status).toBe('done');
  });

  it('owns markdown preview download independently from normal transfer progress', async () => {
    const onDownloadComplete = vi.fn();
    const runtime = createFileTransferSessionRuntime({
      now: () => 400,
      randomId: () => 'prev',
      onDownloadComplete,
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'README.md', size: 7 }, '/remote/home');

    expect(preview.requestId).toBe('fpv-400-prev');
    expect(runtime.getState().preview.loading).toBe(true);
    expect(runtime.getState().transfers).toHaveLength(0);

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'README.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: 'IyBUaXRsZQ==',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'README.md',
        totalBytes: 7,
      },
    });

    expect(onDownloadComplete).not.toHaveBeenCalled();
    expect(runtime.getState().preview).toMatchObject({
      fileName: 'README.md',
      loading: false,
      text: '# Title',
      error: null,
    });
    expect(runtime.getState().transfers).toHaveLength(0);
  });
});
