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
      payload: { requestId: upload.requestId },
    });
    expect(runtime.getState().transfers[0]?.status).toBe('done');
  });
});
