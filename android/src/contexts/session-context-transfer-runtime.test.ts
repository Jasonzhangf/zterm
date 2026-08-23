// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import {
  createImagePasteWaiterRuntime,
  ensureSessionReadyForPasteRuntime,
  sendFileAttachRuntime,
  sendImagePasteRuntime,
} from './session-context-transfer-runtime';

function makeFile(name: string, size: number, type = 'image/png') {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return new File([bytes], name, { type });
}

function createUploadAckRuntime() {
  const handlers = new Set<(message: any) => void>();
  return {
    subscribe(handler: (message: any) => void) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    progress(chunkCount: number) {
      handlers.forEach((handler) => handler({
        type: 'file-upload-progress',
        payload: { requestId: 'any', chunkIndex: chunkCount, totalChunks: chunkCount },
      }));
    },
    complete() {
      handlers.forEach((handler) => handler({
        type: 'file-upload-complete',
        payload: { requestId: 'any', filePath: '/staged', bytes: 0 },
      }));
    },
    finishAll() {
      this.progress(1);
      this.complete();
    },
  };
}

function finishUploadSoon(uploadAcks: ReturnType<typeof createUploadAckRuntime>, chunks = 1) {
  setTimeout(() => {
    uploadAcks.progress(chunks);
    uploadAcks.complete();
  }, 0);
}

describe('session-context-transfer-runtime', () => {
  it('waits for paste readiness through client.daemon_connection without raw socket fallback', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;

    await expect(ensureSessionReadyForPasteRuntime({
      sessionId: 'session-1',
      timeoutMs: 10,
      sessions: [{ id: 'session-1', state: 'connected' } as any],
      daemonConnection: {
        readSessionResource: vi.fn(() => ({ socket: ws } as any)),
        readSessionSocket: vi.fn(() => ws),
        readOpenSessionSocket: vi.fn(() => ws),
        sendSessionMessage: vi.fn(),
        sendSessionRaw: vi.fn(),
      },
    })).resolves.toBe(ws);
  });

  it('chunks image paste binary payloads so RTC relay does not send one oversized datachannel frame', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const imagePasteWaiterRuntime = {
      wait: vi.fn(async () => undefined),
      resolve: vi.fn(),
      reject: vi.fn(),
      dispose: vi.fn(),
    } as any;
    const uploadAcks = createUploadAckRuntime();
    finishUploadSoon(uploadAcks, 5);

    await sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 70000),
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      subscribeFileTransferMessages: uploadAcks.subscribe,
      sendSocketPayload,
    });

    const wireFrames = sendSocketPayload.mock.calls
      .map((call) => call[2])
      .filter((payload) => typeof payload === 'string')
      .map((payload) => JSON.parse(payload as string));

    expect(wireFrames.filter((frame) => frame.type === 'file-upload-chunk')).toHaveLength(5);
    expect(wireFrames.map((frame) => frame.type)).toEqual([
      'file-upload-start',
      'file-upload-chunk',
      'file-upload-chunk',
      'file-upload-chunk',
      'file-upload-chunk',
      'file-upload-chunk',
      'file-upload-end',
      'paste-image-from-upload',
    ]);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'file-upload-start',
      payload: {
        fileSize: 70000,
        chunkCount: 5,
        pasteImage: {
          name: 'proof.png',
          mimeType: 'image/png',
          byteLength: 70000,
          pasteSequence: '\x16',
        },
      },
    });
  });

  it('accepts an open transfer transport even while the projected session state is still recovering', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;

    await expect(ensureSessionReadyForPasteRuntime({
      sessionId: 'session-1',
      timeoutMs: 10,
      sessions: [{ id: 'session-1', state: 'reconnecting' } as any],
      daemonConnection: {
        readSessionSocket: vi.fn(() => ws),
      } as any,
    })).resolves.toBe(ws);
  });

  it('requests one bounded reconnect when transfer transport is unavailable and waits for recovery', async () => {
    const closedSocket = { readyState: WebSocket.CLOSED } as any;
    const openSocket = { readyState: WebSocket.OPEN } as any;
    let sockets = [closedSocket, closedSocket, openSocket];
    const requestReconnect = vi.fn();

    await expect(ensureSessionReadyForPasteRuntime({
      sessionId: 'session-1',
      timeoutMs: 300,
      sessions: [{ id: 'session-1', state: 'disconnected' } as any],
      daemonConnection: {
        readSessionSocket: vi.fn(() => sockets.shift() || openSocket),
      } as any,
      requestReconnect,
    })).resolves.toBe(openSocket);

    expect(requestReconnect).toHaveBeenCalledTimes(1);
    expect(requestReconnect).toHaveBeenCalledWith(
      'session-1',
      'transfer transport unavailable',
    );
  });

  it('serializes remote-window paste target without terminal Ctrl+V sequence', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const imagePasteWaiterRuntime = {
      wait: vi.fn(async () => undefined),
      resolve: vi.fn(),
      reject: vi.fn(),
      dispose: vi.fn(),
    } as any;
    const uploadAcks = createUploadAckRuntime();
    finishUploadSoon(uploadAcks);

    await sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      pasteTarget: {
        kind: 'remote-window',
        streamId: 'stream-1',
        targetId: 'target-1',
      },
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      subscribeFileTransferMessages: uploadAcks.subscribe,
      sendSocketPayload,
    });

    const startFrame = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(startFrame).toMatchObject({
      type: 'file-upload-start',
      payload: {
        fileSize: 4,
        chunkCount: 1,
        pasteImage: {
          name: 'proof.png',
          mimeType: 'image/png',
          byteLength: 4,
          pasteTarget: {
            kind: 'remote-window',
            streamId: 'stream-1',
            targetId: 'target-1',
          },
        },
      },
    });
    expect(startFrame.payload.pasteSequence).toBeUndefined();
  });

  it('rejects when the daemon reports a paste failure instead of resolving after wire send', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    let rejectImagePaste!: (error: Error) => void;
    const imagePasteResult = new Promise<void>((_resolve, reject) => {
      rejectImagePaste = reject;
    });
    imagePasteResult.catch(() => {});
    const imagePasteWaiterRuntime = {
      wait: vi.fn(() => imagePasteResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      dispose: vi.fn(),
    } as any;
    const uploadAcks = createUploadAckRuntime();
    finishUploadSoon(uploadAcks);

    const pending = sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      subscribeFileTransferMessages: uploadAcks.subscribe,
      sendSocketPayload,
    });
    setTimeout(() => rejectImagePaste(new Error('Failed to paste image: sips failed')), 0);

    await expect(pending).rejects.toThrow('Failed to paste image: sips failed');
  });

  it('rejects when the Herdr backend explicitly rejects file transfer', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    let rejectImagePaste!: (error: Error) => void;
    const imagePasteResult = new Promise<void>((_resolve, reject) => {
      rejectImagePaste = reject;
    });
    imagePasteResult.catch(() => {});
    const imagePasteWaiterRuntime = {
      wait: vi.fn(() => imagePasteResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      dispose: vi.fn(),
    } as any;
    const uploadAcks = createUploadAckRuntime();
    finishUploadSoon(uploadAcks);

    const pending = sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      subscribeFileTransferMessages: uploadAcks.subscribe,
      sendSocketPayload,
    });
    setTimeout(() => rejectImagePaste(
      new Error('paste image is not supported by the Herdr single-session terminal surface'),
    ), 0);

    await expect(pending).rejects.toThrow('Herdr single-session');
  });

  it('rejects with an explicit timeout when the daemon never returns image-pasted', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const imagePasteWaiterRuntime = createImagePasteWaiterRuntime();
    const uploadAcks = createUploadAckRuntime();
    finishUploadSoon(uploadAcks);

    await expect(sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      imagePasteWaiterRuntime,
      imagePasteResultTimeoutMs: 5,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      subscribeFileTransferMessages: uploadAcks.subscribe,
      sendSocketPayload,
    })).rejects.toThrow('image paste result timeout');
  });

  it('waiter store resolves and rejects only the currently pending image paste', async () => {
    const imagePasteWaiterRuntime = createImagePasteWaiterRuntime();
    const pending = imagePasteWaiterRuntime.wait('session-1', 1000);
    setTimeout(() => imagePasteWaiterRuntime.resolve('session-1'), 0);
    await pending;

    const rejected = imagePasteWaiterRuntime.wait('session-1', 1000);
    setTimeout(() => imagePasteWaiterRuntime.reject('session-1', 'daemon rejected'), 0);
    await expect(rejected).rejects.toThrow('daemon rejected');
  });

  it('chunks file attach binary payloads through the same transfer path', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    await sendFileAttachRuntime({
      sessionId: 'session-1',
      file: makeFile('archive.bin', 50000, 'application/octet-stream'),
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      sendSocketPayload,
    });

    const binaryFrames = sendSocketPayload.mock.calls
      .map((call) => call[2])
      .filter((payload) => payload instanceof ArrayBuffer) as ArrayBuffer[];

    expect(binaryFrames.length).toBeGreaterThan(1);
    expect(binaryFrames.every((frame) => frame.byteLength <= 16 * 1024)).toBe(true);
    expect(binaryFrames.reduce((total, frame) => total + frame.byteLength, 0)).toBe(50000);
  });
});
