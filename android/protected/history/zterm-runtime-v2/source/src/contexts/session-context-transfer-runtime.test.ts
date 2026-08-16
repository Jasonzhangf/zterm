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

    await sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 70000),
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      sendSocketPayload,
    });

    const binaryFrames = sendSocketPayload.mock.calls
      .map((call) => call[2])
      .filter((payload) => payload instanceof ArrayBuffer) as ArrayBuffer[];

    expect(binaryFrames.length).toBeGreaterThan(1);
    expect(binaryFrames.every((frame) => frame.byteLength <= 16 * 1024)).toBe(true);
    expect(binaryFrames.reduce((total, frame) => total + frame.byteLength, 0)).toBe(70000);
    expect(JSON.parse(sendSocketPayload.mock.calls[0][2] as string)).toMatchObject({
      type: 'paste-image-start',
      payload: {
        name: 'proof.png',
        mimeType: 'image/png',
        byteLength: 70000,
        pasteSequence: '\x16',
      },
    });
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
      sendSocketPayload,
    });

    const startFrame = JSON.parse(sendSocketPayload.mock.calls[0][2] as string);
    expect(startFrame).toMatchObject({
      type: 'paste-image-start',
      payload: {
        name: 'proof.png',
        mimeType: 'image/png',
        byteLength: 4,
        pasteTarget: {
          kind: 'remote-window',
          streamId: 'stream-1',
          targetId: 'target-1',
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
    const imagePasteWaiterRuntime = {
      wait: vi.fn(() => imagePasteResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const pending = sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      sendSocketPayload,
    });
    rejectImagePaste(new Error('Failed to paste image: sips failed'));

    await expect(pending).rejects.toThrow('Failed to paste image: sips failed');
  });

  it('rejects when the Herdr backend explicitly rejects file transfer', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    let rejectImagePaste!: (error: Error) => void;
    const imagePasteResult = new Promise<void>((_resolve, reject) => {
      rejectImagePaste = reject;
    });
    const imagePasteWaiterRuntime = {
      wait: vi.fn(() => imagePasteResult),
      resolve: vi.fn(),
      reject: vi.fn(),
      dispose: vi.fn(),
    } as any;

    const pending = sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      imagePasteWaiterRuntime,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
      sendSocketPayload,
    });
    rejectImagePaste(new Error('paste image is not supported by the Herdr single-session terminal surface'));

    await expect(pending).rejects.toThrow('Herdr single-session');
  });

  it('rejects with an explicit timeout when the daemon never returns image-pasted', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();
    const imagePasteWaiterRuntime = createImagePasteWaiterRuntime();

    await expect(sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      imagePasteWaiterRuntime,
      imagePasteResultTimeoutMs: 5,
      ensureSessionReadyForPaste: vi.fn(async () => ws),
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
