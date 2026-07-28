import { describe, expect, it } from 'vitest';
import {
  TERMINAL_MUX_PROTOCOL_VERSION,
  buildTerminalMuxCapabilities,
  buildTerminalMuxChannelBinary,
  buildTerminalMuxChannelMessage,
  buildTerminalMuxError,
  buildTerminalMuxHello,
  buildTerminalMuxPing,
  buildTerminalMuxReady,
  buildTerminalMuxServerChannelMessage,
  buildTerminalMuxServerTargetMessage,
  buildTerminalMuxTargetMessage,
  buildTerminalMuxUnwrappedSessionMessageError,
  classifyTerminalMuxClientMessage,
  isTerminalMuxClientFrame,
  isTerminalMuxServerFrame,
  validateTerminalMuxChannelEnvelope,
  type TerminalMuxChannelClientMessage,
  type TerminalMuxTargetClientMessage,
  FILE_TRANSFER_WIRE_CHUNK_BYTES,
  FILE_TRANSFER_WIRE_FRAME_MAX_CHARS,
} from './protocol';

describe('terminal mux protocol contract', () => {
  it('builds the only target-level mux ping envelope', () => {
    expect(buildTerminalMuxPing(1234)).toEqual({
      type: 'mux-ping',
      payload: { sentAt: 1234 },
    });
    expect(isTerminalMuxClientFrame(buildTerminalMuxPing(1234))).toBe(true);
    expect(() => buildTerminalMuxPing(Number.NaN)).toThrow(
      'terminal mux ping sentAt must be a non-negative safe integer',
    );
    expect(() => buildTerminalMuxPing(1234.9)).toThrow(
      'terminal mux ping sentAt must be a non-negative safe integer',
    );
    expect(() => buildTerminalMuxPing(-1)).toThrow(
      'terminal mux ping sentAt must be a non-negative safe integer',
    );
    expect(() => buildTerminalMuxPing(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      'terminal mux ping sentAt must be a non-negative safe integer',
    );
  });

  it('builds and validates hello / ready frames with explicit version and capabilities', () => {
    const hello = buildTerminalMuxHello('android-client-1');
    expect(hello).toEqual({
      type: 'mux-hello',
      payload: {
        version: TERMINAL_MUX_PROTOCOL_VERSION,
        clientInstanceId: 'android-client-1',
      },
    });
    expect(isTerminalMuxClientFrame(hello)).toBe(true);
    expect(isTerminalMuxClientFrame({
      type: 'mux-hello',
      payload: { version: 2, clientInstanceId: 'android-client-1' },
    })).toBe(false);

    const ready = buildTerminalMuxReady({
      daemonHostId: 'daemon-a',
      capabilities: buildTerminalMuxCapabilities({
        relayPeerResume: {
          version: 1,
          idleTimeoutMs: 120000,
        },
      }),
    });
    expect(isTerminalMuxServerFrame(ready)).toBe(true);
    expect(ready.payload.capabilities).toMatchObject({
      version: TERMINAL_MUX_PROTOCOL_VERSION,
      channelEnvelope: true,
      targetMessages: true,
      boundedBodyScheduler: true,
      relayPeerResume: {
        version: 1,
        idleTimeoutMs: 120000,
      },
    });
  });

  it('classifies target, channel, and legacy messages without hidden fallback', () => {
    expect(classifyTerminalMuxClientMessage({ type: 'list-sessions' })).toBe('target');
    expect(classifyTerminalMuxClientMessage({ type: 'tmux-kill-session' })).toBe('target');
    expect(classifyTerminalMuxClientMessage({ type: 'input' })).toBe('channel');
    expect(classifyTerminalMuxClientMessage({ type: 'debug-log' })).toBe('channel');
    expect(classifyTerminalMuxClientMessage({ type: 'debug-snapshot' })).toBe('channel');
    expect(classifyTerminalMuxClientMessage({ type: 'remote-window-input' })).toBe('channel');
    expect(classifyTerminalMuxClientMessage({ type: 'session-open' })).toBe('legacy');
    expect(classifyTerminalMuxClientMessage({ type: 'connect' })).toBe('legacy');
  });

  it('wraps session-bound payloads in channel envelopes and rejects target payloads there', () => {
    const inputMessage = {
      type: 'input',
      payload: 'ls\n',
    } satisfies TerminalMuxChannelClientMessage;

    const frame = buildTerminalMuxChannelMessage('channel-main', inputMessage);
    expect(frame).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-main',
        message: inputMessage,
      },
    });
    expect(isTerminalMuxClientFrame(frame)).toBe(true);

    const targetMessage = {
      type: 'list-sessions',
    } satisfies TerminalMuxTargetClientMessage;

    expect(() => buildTerminalMuxChannelMessage(
      'channel-main',
      targetMessage as unknown as TerminalMuxChannelClientMessage,
    )).toThrow(/cannot carry list-sessions/);
    expect(buildTerminalMuxTargetMessage(targetMessage)).toEqual({
      type: 'mux-target-message',
      payload: {
        message: targetMessage,
      },
    });
  });

  it('returns explicit errors for unwrapped session messages and channel validation failures', () => {
    expect(buildTerminalMuxUnwrappedSessionMessageError('input')).toEqual(
      buildTerminalMuxError(
        'mux_unwrapped_session_message',
        'session-bound message input must be sent inside mux-channel-message',
      ),
    );

    const unknown = validateTerminalMuxChannelEnvelope(
      {
        type: 'mux-channel-message',
        payload: {
          channelId: 'missing',
          message: { type: 'input', payload: 'x' },
        },
      },
      { hasChannel: () => false },
    );
    expect(unknown).toMatchObject({
      ok: false,
      error: {
        type: 'mux-error',
        payload: {
          code: 'mux_unknown_channel',
          channelId: 'missing',
        },
      },
    });

    const mismatch = validateTerminalMuxChannelEnvelope(
      {
        type: 'mux-channel-message',
        payload: {
          channelId: 'channel-b',
          message: { type: 'input', payload: 'x' },
        },
      },
      {
        expectedChannelId: 'channel-a',
        hasChannel: () => true,
      },
    );
    expect(mismatch).toMatchObject({
      ok: false,
      error: {
        type: 'mux-error',
        payload: {
          code: 'mux_channel_mismatch',
          channelId: 'channel-b',
        },
      },
    });
  });

  it('accepts only known channel client message envelopes', () => {
    expect(isTerminalMuxClientFrame({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: { type: 'input', payload: 'pwd\n' },
      },
    })).toBe(true);
    expect(isTerminalMuxClientFrame({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: { type: 'list-sessions' },
      },
    })).toBe(false);
    expect(isTerminalMuxClientFrame({
      type: 'input',
      payload: 'pwd\n',
    })).toBe(false);
  });

  it('wraps binary upload chunks with explicit channel identity', () => {
    const frame = buildTerminalMuxChannelBinary('channel-a', 'aGVsbG8=');
    expect(frame).toEqual({
      type: 'mux-channel-binary',
      payload: {
        channelId: 'channel-a',
        dataBase64: 'aGVsbG8=',
      },
    });
    expect(isTerminalMuxClientFrame(frame)).toBe(true);
    expect(isTerminalMuxClientFrame({
      type: 'mux-channel-binary',
      payload: {
        channelId: '',
        dataBase64: 'aGVsbG8=',
      },
    })).toBe(false);
  });

  it('wraps server-side session responses in channel envelopes without treating generic errors as target-only', () => {
    expect(buildTerminalMuxServerChannelMessage('channel-a', {
      type: 'error',
      payload: {
        message: 'resize requires an attached mirror',
        code: 'session_not_ready',
      },
    })).toEqual({
      type: 'mux-channel-message',
      payload: {
        channelId: 'channel-a',
        message: {
          type: 'error',
          payload: {
            message: 'resize requires an attached mirror',
            code: 'session_not_ready',
          },
        },
      },
    });
    expect(isTerminalMuxServerFrame(buildTerminalMuxServerTargetMessage({
      type: 'sessions',
      payload: { sessions: ['a', 'b'] },
    }))).toBe(true);
  });
});

describe('file transfer wire chunk contract', () => {
  it('keeps base64 file-transfer frames under the RTC-safe budget', () => {
    const raw = 'a'.repeat(FILE_TRANSFER_WIRE_CHUNK_BYTES);
    const dataBase64 = Buffer.from(raw, 'utf8').toString('base64');
    const frame = JSON.stringify({
      type: 'mux-channel-message',
      payload: {
        channelId: 'ch-1',
        message: {
          type: 'file-upload-chunk',
          payload: {
            requestId: 'ful-1',
            chunkIndex: 0,
            dataBase64,
          },
        },
      },
    });
    expect(FILE_TRANSFER_WIRE_CHUNK_BYTES).toBe(16 * 1024);
    expect(frame.length).toBeLessThanOrEqual(FILE_TRANSFER_WIRE_FRAME_MAX_CHARS);
  });
});
