import { describe, expect, it, vi } from 'vitest';
import { createFileTransferSessionRuntime } from './file-transfer-session-runtime';
import {
  FILE_TRANSFER_UPLOAD_RESUME_RETRY_DELAY_MS,
  FILE_TRANSFER_UPLOAD_RESUME_RETRY_LIMIT,
} from './file-transfer-throughput-runtime';

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
    expect(runtime.getState().remoteError).toBeNull();
  });

  it('keeps remote list errors as explicit browser truth instead of empty rows', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 110,
      randomId: () => 'errl',
    });

    runtime.open('');
    const request = runtime.requestRemoteList('', true);

    await runtime.applyMessage({
      type: 'file-list-error',
      payload: {
        requestId: request.requestId,
        error: 'tmux pane current path unavailable',
      },
    });

    expect(runtime.getState().remoteLoading).toBe(false);
    expect(runtime.getState().remoteEntries).toHaveLength(0);
    expect(runtime.getState().remoteError).toBe('tmux pane current path unavailable');
  });

  it('ignores stale remote list errors from an older request', async () => {
    let timestamp = 120;
    const runtime = createFileTransferSessionRuntime({
      now: () => timestamp,
      randomId: () => 'list',
    });

    runtime.open('/remote/old');
    const oldRequest = runtime.requestRemoteList('/remote/old', true);
    timestamp = 121;
    const newRequest = runtime.requestRemoteList('/remote/new', true);

    await expect(runtime.applyMessage({
      type: 'file-list-error',
      payload: {
        requestId: oldRequest.requestId,
        error: 'old directory disappeared',
      },
    })).resolves.toBe(false);

    expect(runtime.getState().remoteLoading).toBe(true);
    expect(runtime.getState().remoteError).toBeNull();

    await runtime.applyMessage({
      type: 'file-list-response',
      payload: {
        requestId: newRequest.requestId,
        path: '/remote/new',
        parentPath: '/remote',
        entries: [{ name: 'fresh.md', type: 'file', size: 1, modified: 1 }],
      },
    });

    expect(runtime.getState().remotePath).toBe('/remote/new');
    expect(runtime.getState().remoteEntries[0]?.name).toBe('fresh.md');
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

    const firstProgress = upload.waitForProgress(1);
    await runtime.applyMessage({
      type: 'file-upload-progress',
      payload: {
        requestId: upload.requestId,
        chunkIndex: 1,
        totalChunks: 3,
      },
    });
    await expect(firstProgress).resolves.toBeUndefined();

    const secondProgress = upload.waitForProgress(2);
    await runtime.applyMessage({
      type: 'file-upload-progress',
      payload: {
        requestId: upload.requestId,
        chunkIndex: 2,
        totalChunks: 3,
      },
    });
    await expect(secondProgress).resolves.toBeUndefined();
    expect(runtime.getState().transfers[0]?.transferredBytes).toBe(2);

    const done = upload.waitForDone();
    await runtime.applyMessage({
      type: 'file-upload-complete',
      payload: { requestId: upload.requestId, filePath: '/remote/home/c.txt', bytes: 8192 },
    });
    await expect(done).resolves.toBeUndefined();
    expect(runtime.getState().transfers[0]?.status).toBe('done');
  });

  it('exposes the last acknowledged upload chunk as the resume point', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 320,
      randomId: () => 'rsme',
    });

    runtime.open('/remote/home');
    const upload = runtime.startUpload({ name: 'resume.bin', size: 3072 }, '/remote/home', 3);

    expect(upload.resumePolicy).toEqual({
      maxAttempts: FILE_TRANSFER_UPLOAD_RESUME_RETRY_LIMIT,
      delayMs: FILE_TRANSFER_UPLOAD_RESUME_RETRY_DELAY_MS,
      getResumeChunkIndex: expect.any(Function),
    });
    expect(upload.resumePolicy.getResumeChunkIndex()).toBe(0);
    expect(runtime.getUploadResumeChunk(upload.requestId)).toBe(0);

    await runtime.applyMessage({
      type: 'file-upload-progress',
      payload: {
        requestId: upload.requestId,
        chunkIndex: 1,
        totalChunks: 3,
      },
    });
    expect(runtime.getUploadResumeChunk(upload.requestId)).toBe(1);

    await runtime.applyMessage({
      type: 'file-upload-complete',
      payload: { requestId: upload.requestId },
    });
    expect(runtime.getUploadResumeChunk(upload.requestId)).toBe(3);
    expect(upload.resumePolicy.getResumeChunkIndex()).toBe(3);
    expect(runtime.getUploadResumeChunk('missing-upload')).toBeNull();
  });

  it('fails upload progress waiters when daemon returns an explicit upload error', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 310,
      randomId: () => 'err1',
    });

    runtime.open('/remote/home');
    const upload = runtime.startUpload({ name: 'broken.bin', size: 4096 }, '/remote/home', 2);
    const progress = upload.waitForProgress(1);

    await runtime.applyMessage({
      type: 'file-upload-error',
      payload: {
        requestId: upload.requestId,
        error: 'disk full',
      },
    });

    await expect(progress).rejects.toThrow(/disk full/);
    expect(runtime.getState().transfers[0]?.status).toBe('error');
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

  it('decodes remote text preview chunks independently so padded base64 chunks still open', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 410,
      randomId: () => 'pad',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'note.md', size: 2 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'note.md',
        chunkIndex: 0,
        totalChunks: 2,
        dataBase64: 'SA==',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'note.md',
        chunkIndex: 1,
        totalChunks: 2,
        dataBase64: 'aQ==',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'note.md',
        totalBytes: 2,
      },
    });

    expect(runtime.getState().preview).toMatchObject({
      fileName: 'note.md',
      loading: false,
      text: 'Hi',
      error: null,
    });
  });

  it('preserves a UTF-8 BOM in remote text previews', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 415,
      randomId: () => 'bom',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'bom.md', size: 10 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'bom.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: '77u/IyBUaXRsZQ==',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'bom.md',
        totalBytes: 10,
      },
    });

    expect(runtime.getState().preview).toMatchObject({
      fileName: 'bom.md',
      loading: false,
      text: '\ufeff# Title',
      error: null,
    });
  });

  it('rejects incomplete remote text preview assemblies instead of publishing partial text', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 418,
      randomId: () => 'gap',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'gap.md', size: 2 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'gap.md',
        chunkIndex: 1,
        totalChunks: 2,
        dataBase64: 'aQ==',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'gap.md',
        totalBytes: 2,
      },
    });

    expect(runtime.getState().preview.fileName).toBe('gap.md');
    expect(runtime.getState().preview.loading).toBe(false);
    expect(runtime.getState().preview.text).toBeNull();
    expect(runtime.getState().preview.error).toContain('incomplete text preview');
  });

  it('rejects remote text preview size mismatches before exposing editable text', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 419,
      randomId: () => 'size',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'size.md', size: 3 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'size.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: 'aGk=',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'size.md',
        totalBytes: 3,
      },
    });

    expect(runtime.getState().preview.fileName).toBe('size.md');
    expect(runtime.getState().preview.loading).toBe(false);
    expect(runtime.getState().preview.text).toBeNull();
    expect(runtime.getState().preview.error).toContain('text preview size mismatch');
  });

  it('rejects invalid UTF-8 remote previews instead of producing replacement text', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 420,
      randomId: () => 'bad',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'broken.md', size: 1 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'broken.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: '/w==',
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'broken.md',
        totalBytes: 1,
      },
    });

    expect(runtime.getState().preview.fileName).toBe('broken.md');
    expect(runtime.getState().preview.loading).toBe(false);
    expect(runtime.getState().preview.text).toBeNull();
    expect(runtime.getState().preview.error).toBeTruthy();
  });

  it('turns malformed base64 preview chunks into visible preview errors', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 425,
      randomId: () => 'b64',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'bad-base64.md', size: 1 }, '/remote/home');

    await expect(runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'bad-base64.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: '%',
      },
    })).resolves.toBe(true);

    expect(runtime.getState().preview.fileName).toBe('bad-base64.md');
    expect(runtime.getState().preview.loading).toBe(false);
    expect(runtime.getState().preview.text).toBeNull();
    expect(runtime.getState().preview.error).toContain('invalid text preview chunk 0');
  });

  it('rejects remote text preview chunks above the preview byte cap', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 430,
      randomId: () => 'huge',
    });
    const oversizedText = 'a'.repeat(512 * 1024 + 1);

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'grown.md', size: 1 }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'grown.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: Buffer.from(oversizedText, 'utf8').toString('base64'),
      },
    });

    expect(runtime.getState().preview.fileName).toBe('grown.md');
    expect(runtime.getState().preview.loading).toBe(false);
    expect(runtime.getState().preview.text).toBeNull();
    expect(runtime.getState().preview.error).toContain('512 KiB');
  });

  it('does not double count duplicate remote text preview chunks toward the byte cap', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 431,
      randomId: () => 'dup',
    });
    const text = 'a'.repeat(512 * 1024);
    const dataBase64 = Buffer.from(text, 'utf8').toString('base64');

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'duplicate.md', size: text.length }, '/remote/home');

    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'duplicate.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64,
      },
    });
    await runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'duplicate.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64,
      },
    });
    await runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'duplicate.md',
        totalBytes: text.length,
      },
    });

    expect(runtime.getState().preview.error).toBeNull();
    expect(runtime.getState().preview.text).toBe(text);
  });

  it('ignores late preview chunks after the preview is cleared', async () => {
    const runtime = createFileTransferSessionRuntime({
      now: () => 432,
      randomId: () => 'clear',
    });

    runtime.open('/remote/home');
    const preview = runtime.startPreview({ name: 'late.md', size: 4 }, '/remote/home');
    runtime.clearPreview();

    await expect(runtime.applyMessage({
      type: 'file-download-chunk',
      payload: {
        requestId: preview.requestId,
        fileName: 'late.md',
        chunkIndex: 0,
        totalChunks: 1,
        dataBase64: 'bGF0ZQ==',
      },
    })).resolves.toBe(false);
    await expect(runtime.applyMessage({
      type: 'file-download-complete',
      payload: {
        requestId: preview.requestId,
        fileName: 'late.md',
        totalBytes: 4,
      },
    })).resolves.toBe(false);

    expect(runtime.getState().preview).toMatchObject({
      requestId: null,
      fileName: null,
      loading: false,
      text: null,
      error: null,
    });
  });
});
