import { describe, expect, it } from 'vitest';
import {
  APP_FILE_CHUNK_BYTES,
  APP_MAX_FILE_BYTES,
  APP_MAX_MESSAGE_BYTES,
  APP_MAX_PATH_IDENTITY_BYTES,
  AppProtocolError,
  assertAppProtocolVersion,
  computeAppChunkCount,
  decodeAppPathSegment,
  encodeAppPathSegment,
  validateAppClientFrame,
  validateAppFileMetadata,
  validateAppServerFrame,
  validateMessageBody,
  validateSafeFileName,
} from './app-protocol';

function expectCode(run: () => unknown, code: string) {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(AppProtocolError);
  expect((error as AppProtocolError).code).toBe(code);
}

describe('app protocol v1', () => {
  it('rejects a different protocol version', () => {
    expect(assertAppProtocolVersion(1)).toBe(1);
    expectCode(() => assertAppProtocolVersion(2), 'invalid_version');
  });

  it('preserves multiline and JSON bodies and enforces 1 MiB', () => {
    const body = 'line one\nline two\n{"json":"exact"}';
    expect(validateMessageBody(body)).toBe(body);
    expect(validateMessageBody('x'.repeat(APP_MAX_MESSAGE_BYTES))).toHaveLength(APP_MAX_MESSAGE_BYTES);
    expectCode(() => validateMessageBody('x'.repeat(APP_MAX_MESSAGE_BYTES + 1)), 'message_too_large');
    expectCode(() => validateMessageBody(42), 'invalid_frame');
  });

  it('validates file size, chunk count, digest, and basename policy', () => {
    const bytes = 40_000;
    const file = validateAppFileMetadata({
      transferId: 'transfer-1',
      fileName: 'evidence.bin',
      totalBytes: bytes,
      chunkCount: computeAppChunkCount(bytes),
      sha256: 'a'.repeat(64),
    }, 'test');
    expect(file.chunkCount).toBe(Math.ceil(bytes / APP_FILE_CHUNK_BYTES));
    expectCode(() => validateAppFileMetadata({
      ...file,
      totalBytes: APP_MAX_FILE_BYTES + 1,
      chunkCount: computeAppChunkCount(APP_MAX_FILE_BYTES + 1),
    }, 'test'), 'file_too_large');
    expectCode(() => validateAppFileMetadata({ ...file, chunkCount: 1 }, 'test'), 'invalid_frame');
    expectCode(() => validateAppFileMetadata({ ...file, sha256: 'not-a-digest' }, 'test'), 'invalid_frame');
    for (const fileName of ['../escape', 'a/b', 'a\\b', '', '.', '..']) {
      expectCode(() => validateSafeFileName(fileName, 'test'), 'invalid_file_name');
    }
    expectCode(() => validateSafeFileName('x'.repeat(256), 'test'), 'invalid_file_name');
  });

  it('round-trips reversible base64url path segments and caps identity bytes', () => {
    const identities = ['daemon-host', '设备-身份', 'a b+c/d', 'x'.repeat(APP_MAX_PATH_IDENTITY_BYTES)];
    for (const identity of identities) {
      const encoded = encodeAppPathSegment(identity);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeAppPathSegment(encoded)).toBe(identity);
    }
    expectCode(() => encodeAppPathSegment(''), 'invalid_frame');
    expectCode(() => encodeAppPathSegment('é'.repeat(96)), 'invalid_frame');
  });

  it('validates the documented client frame surface', () => {
    const ping = validateAppClientFrame({
      type: 'app-ping',
      payload: { requestId: 'ping-1', sentAt: 123 },
    });
    expect(ping).toMatchObject({ type: 'app-ping', payload: { sentAt: 123 } });
    const send = validateAppClientFrame({
      type: 'app-send-message',
      payload: {
        requestId: 'r1',
        messageId: 'm1',
        subject: 'subject',
        body: 'line one\nline two',
      },
    });
    expect(send.type).toBe('app-send-message');
    expectCode(() => validateAppClientFrame({
      type: 'app-unknown',
      payload: {},
    }), 'invalid_frame');
    expectCode(() => validateAppClientFrame({
      type: 'app-ping',
      payload: { requestId: 'r1', sentAt: Number.NaN },
    }), 'invalid_frame');
  });

  it('accepts an omitted file subject while keeping the subject type check', () => {
    const file = validateAppFileMetadata({
      transferId: 'transfer-1',
      fileName: 'evidence.bin',
      totalBytes: 40_000,
      chunkCount: computeAppChunkCount(40_000),
      sha256: 'a'.repeat(64),
    }, 'test');
    const frame = validateAppClientFrame({
      type: 'app-send-file-start',
      payload: { requestId: 'r1', messageId: 'm1', subject: '', file },
    });
    expect(frame).toMatchObject({ type: 'app-send-file-start', payload: { subject: '' } });
    expectCode(() => validateAppClientFrame({
      type: 'app-send-file-start',
      payload: { requestId: 'r1', messageId: 'm1', subject: 42, file },
    }), 'invalid_frame');
  });

  it('validates server frames at runtime and rejects malformed payloads', () => {
    const ready = validateAppServerFrame({
      type: 'app-ready',
      payload: {
        requestId: 'r1',
        protocolVersion: 1,
        deviceId: 'device-b',
        daemonHostId: 'daemon-b',
        capabilities: {},
      },
    });
    expect(ready).toMatchObject({ type: 'app-ready', payload: { requestId: 'r1' } });

    expectCode(() => validateAppServerFrame(null), 'invalid_frame');
    expectCode(() => validateAppServerFrame({ type: 'app-ready' }), 'invalid_frame');
    expectCode(() => validateAppServerFrame({ type: 'app-unknown', payload: {} }), 'invalid_frame');
    expectCode(() => validateAppServerFrame({
      type: 'app-ready',
      payload: { requestId: 'r1', protocolVersion: 2, deviceId: 'device-b', daemonHostId: 'daemon-b', capabilities: {} },
    }), 'invalid_version');
    expectCode(() => validateAppServerFrame({
      type: 'app-send-result',
      payload: { requestId: 'r1', messageId: 'm1', status: 'bogus', stage: 'sent' },
    }), 'invalid_frame');
    expectCode(() => validateAppServerFrame({
      type: 'app-inbound-message',
      payload: { messageId: 'm1', senderDeviceId: 'a', senderDaemonHostId: 'a', receiverDeviceId: 'b', receiverDaemonHostId: 'b', subject: '', body: '', state: 'bogus', receivedAt: 'now' },
    }), 'invalid_frame');
  });
});
