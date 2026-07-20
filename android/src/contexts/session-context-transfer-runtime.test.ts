// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { sendFileAttachRuntime, sendImagePasteRuntime } from './session-context-transfer-runtime';

function makeFile(name: string, size: number, type = 'image/png') {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    bytes[index] = index % 251;
  }
  return new File([bytes], name, { type });
}

describe('session-context-transfer-runtime', () => {
  it('chunks image paste binary payloads so RTC relay does not send one oversized datachannel frame', async () => {
    const ws = { readyState: WebSocket.OPEN } as any;
    const sendSocketPayload = vi.fn();

    await sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 70000),
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

    await sendImagePasteRuntime({
      sessionId: 'session-1',
      file: makeFile('proof.png', 4),
      pasteTarget: {
        kind: 'remote-window',
        streamId: 'stream-1',
        targetId: 'target-1',
      },
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
