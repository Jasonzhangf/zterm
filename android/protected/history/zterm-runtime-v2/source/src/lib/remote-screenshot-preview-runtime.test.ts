import { describe, expect, it, vi } from 'vitest';
import {
  buildRemoteScreenshotPreviewBlob,
  createRemoteScreenshotPreviewRuntime,
  persistRemoteScreenshotCaptureRuntime,
  resolveRemoteScreenshotQuickBarStatus,
  type RemoteScreenshotPreviewState,
} from './remote-screenshot-preview-runtime';

describe('remote screenshot preview runtime', () => {
  it('builds preview lifecycle and revokes stale urls on close', () => {
    const revoke = vi.fn();
    const runtime = createRemoteScreenshotPreviewRuntime({
      now: () => 123,
      createObjectUrl: vi.fn(() => 'blob:preview-1'),
      revokeObjectUrl: revoke,
    });

    const started = runtime.beginRequest();
    expect(started.requestEpoch).toBe(1);
    expect(started.state).toMatchObject({
      phase: 'request-sent',
      fileName: 'remote-screenshot-123.png',
    });

    const progressed = runtime.applyProgress(started.state, started.requestEpoch, {
      requestId: 'rs-1',
      phase: 'transferring',
      fileName: 'shot.png',
      receivedChunks: 1,
      totalChunks: 2,
      totalBytes: 20,
    });
    expect(progressed).toMatchObject({
      phase: 'transferring',
      fileName: 'shot.png',
      receivedChunks: 1,
      totalChunks: 2,
      totalBytes: 20,
    });

    const completed = runtime.completeCapture(progressed, started.requestEpoch, {
      fileName: 'shot.png',
      mimeType: 'image/png',
      dataBase64: 'Zm9v',
      totalBytes: 3,
      dataBytes: new Uint8Array([102, 111, 111]),
    });
    expect(completed).toMatchObject({
      phase: 'preview-ready',
      fileName: 'shot.png',
      previewDataUrl: 'blob:preview-1',
      rawDataBase64: 'Zm9v',
    });

    expect(runtime.closePreview()).toBeNull();
    expect(revoke).toHaveBeenCalledWith('blob:preview-1');
  });

  it('ignores stale request epochs and reports failed state only for current request', () => {
    const runtime = createRemoteScreenshotPreviewRuntime({ now: () => 456 });
    const first = runtime.beginRequest();
    const second = runtime.beginRequest();

    const staleProgress = runtime.applyProgress(second.state, first.requestEpoch, {
      requestId: 'rs-old',
      phase: 'capturing',
      fileName: 'old.png',
    });
    expect(staleProgress).toBe(second.state);

    const failed = runtime.failCapture(second.state, second.requestEpoch, new Error('boom'));
    expect(failed).toMatchObject({
      phase: 'failed',
      errorMessage: 'boom',
    });
  });

  it('translates preview phase into quickbar status truth', () => {
    const states: Array<[RemoteScreenshotPreviewState | null, string]> = [
      [null, 'idle'],
      [{ phase: 'request-sent', fileName: 'a' }, 'capturing'],
      [{ phase: 'capturing', fileName: 'a' }, 'capturing'],
      [{ phase: 'transferring', fileName: 'a' }, 'transferring'],
      [{ phase: 'transfer-complete', fileName: 'a' }, 'transferring'],
      [{ phase: 'preview-ready', fileName: 'a' }, 'preview-ready'],
      [{ phase: 'saving', fileName: 'a' }, 'saving'],
      [{ phase: 'failed', fileName: 'a' }, 'failed'],
    ];
    states.forEach(([state, expected]) => {
      expect(resolveRemoteScreenshotQuickBarStatus(state as RemoteScreenshotPreviewState | null)).toBe(expected);
    });
  });

  it('persists capture explicitly and surfaces mkdir errors', async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockResolvedValue(undefined);

    const saved = await persistRemoteScreenshotCaptureRuntime({
      fileName: 'shot.png',
      dataBase64: 'Zm9v',
      directory: 'EXT',
      mkdir,
      writeFile,
    });

    expect(saved).toBe('/storage/emulated/0/Download/zterm/shot.png');
    expect(mkdir).toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalled();

    await expect(persistRemoteScreenshotCaptureRuntime({
      fileName: 'shot.png',
      dataBase64: 'Zm9v',
      directory: 'EXT',
      mkdir: vi.fn().mockRejectedValue(new Error('permission denied')),
      writeFile,
    })).rejects.toThrow('创建截图保存目录失败');
  });

  it('builds preview blob from dataBytes or base64 fallback', async () => {
    const fromBytes = buildRemoteScreenshotPreviewBlob({
      fileName: 'bytes.png',
      mimeType: 'image/png',
      dataBase64: 'Zm9v',
      totalBytes: 3,
      dataBytes: new Uint8Array([102, 111, 111]),
    });
    expect(fromBytes.type).toBe('image/png');
    expect(await fromBytes.text()).toBe('foo');

    const fromBase64 = buildRemoteScreenshotPreviewBlob({
      fileName: 'base64.png',
      mimeType: 'image/png',
      dataBase64: 'YmFy',
      totalBytes: 3,
    });
    expect(await fromBase64.text()).toBe('bar');
  });
});
