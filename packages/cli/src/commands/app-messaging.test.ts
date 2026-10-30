import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { SharedConfigStore } from '../../../shared/src/node/shared-config.js';
import type { AccountClient } from '../account-client.js';
import type { AppClientConnection } from '../app-connection.js';
import { AppCliError } from '../app-target-resolution.js';
import {
  appErrorPayload,
  type AppClientFrame,
  type AppServerFrame,
} from '../../../shared/src/connection/app-protocol.js';
import { runAppCommand, type AppCommandContext } from './app-messaging.js';

const USER_ID = 'user-1';
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function collector() {
  let text = '';
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      text += chunk.toString();
      callback();
    },
  });
  return { stream, text: () => text };
}

async function context(options: {
  request: (frame: AppClientFrame) => AppServerFrame;
  stdin?: string;
  connect?: AppCommandContext['connect'];
}) {
  const home = await mkdtemp(join(tmpdir(), 'zterm-cli-app-'));
  roots.push(home);
  await mkdir(join(home, '.zterm'), { recursive: true });
  await writeFile(join(home, '.zterm', 'config.json'), JSON.stringify({
    zterm: {
      android: {
        daemon: { host: '127.0.0.1', port: 9999, authToken: 'cli-secret-token' },
        relay: { hostId: 'daemon-local', deviceId: 'device-local' },
      },
      cli: {
        authGeneration: 1,
        server: { relayBaseUrl: 'http://account.test' },
        auth: {
          loginId: 'login',
          userId: USER_ID,
          username: 'tester',
          accessToken: 'access-secret-token',
          authenticatedAt: new Date(0).toISOString(),
        },
      },
    },
  }, null, 2));
  const user = { id: USER_ID, username: 'tester' };
  const directory = {
    schemaVersion: 1,
    user,
    updatedAt: new Date(0).toISOString(),
    devices: [{
      deviceId: 'device-peer',
      deviceName: 'peer',
      platform: 'test',
      appVersion: 'test',
      client: { connected: true, lastSeenAt: '' },
      daemon: {
        hostId: 'daemon-peer',
        version: 'test',
        presence: { connected: true, lastSeenAt: '' },
        endpoints: [{ id: 'lan', kind: 'lan', authRequired: true, lastSeenAt: '', host: '127.0.0.1', port: 9998, authToken: 'peer-token' }],
        sessions: [],
        lastPublishedAt: '',
      },
    }],
  };
  const accountClient = {
    async me() {
      return { relayBaseUrl: 'http://account.test', accessToken: 'access-secret-token', user, directory };
    },
    async directory() {
      return directory;
    },
  } as unknown as Pick<AccountClient, 'me' | 'directory'>;
  const stdout = collector();
  const stderr = collector();
  const frames: AppClientFrame[] = [];
  const fakeConnection = {
    ready: {
      requestId: 'hello-1',
      protocolVersion: 1,
      deviceId: 'device-local',
      daemonHostId: 'daemon-local',
      capabilities: {},
    },
    async request(frame: AppClientFrame) {
      frames.push(frame);
      return options.request(frame);
    },
    close() {},
  } as unknown as AppClientConnection;
  const commandContext: AppCommandContext = {
    store: new SharedConfigStore({ homeDir: home }),
    accountClient,
    stdin: Readable.from([options.stdin ?? '']),
    stdout: stdout.stream,
    stderr: stderr.stream,
    signal: new AbortController().signal,
    homeDir: home,
    env: {
      ZTERM_HOST: '127.0.0.1',
      ZTERM_PORT: '9999',
      ZTERM_AUTH_TOKEN: 'cli-secret-token',
      ZTERM_TRAVERSAL_DEVICE_ID: 'device-local',
      ZTERM_TRAVERSAL_HOST_ID: 'daemon-local',
    },
    connect: options.connect ?? (async () => fakeConnection),
  };
  return { context: commandContext, stdout, stderr, frames };
}

function ndjson(text: string) {
  const lines = text.split('\n').filter(Boolean);
  expect(lines.every((line) => !line.includes('\u001b['))).toBe(true);
  return lines.map((line) => JSON.parse(line) as AppServerFrame);
}

describe('zterm app CLI surface', () => {
  it('prints help for the command and all six subcommands', async () => {
    for (const args of [
      ['--help'],
      ['stream', '--help'],
      ['send', '--help'],
      ['send-file', '--help'],
      ['status', '--help'],
      ['ack', '--help'],
      ['consume', '--help'],
    ]) {
      const prepared = await context({ request: () => { throw new Error('no request'); } });
      const code = await runAppCommand(args, prepared.context);
      expect(code).toBe(0);
      expect(prepared.stdout.text()).toContain('用法');
      expect(prepared.stderr.text()).toBe('');
    }
  });

  it('sends a multiline message with a generated ID and emits NDJSON without secrets', async () => {
    const prepared = await context({
      request: (frame) => ({
        type: 'app-send-result',
        payload: {
          requestId: 'requestId' in frame.payload ? frame.payload.requestId : 'r',
          messageId: 'messageId' in frame.payload ? frame.payload.messageId : 'm',
          status: 'received',
          stage: 'received',
        },
      }),
    });
    const body = 'line one\nline two\n{"json":"exact"}';
    const code = await runAppCommand([
      'send', '--peer', 'device-peer', '--subject', 'multiline', '--body', body,
    ], prepared.context);
    expect(code).toBe(0);
    const frame = prepared.frames[0]!;
    expect(frame.type).toBe('app-send-message');
    expect('messageId' in frame.payload && frame.payload.messageId.length).toBeGreaterThan(0);
    expect('body' in frame.payload && frame.payload.body).toBe(body);
    const [result] = ndjson(prepared.stdout.text());
    expect(result).toMatchObject({ type: 'app-send-result', payload: { status: 'received' } });
    expect(prepared.stdout.text()).not.toContain('cli-secret-token');
    expect(prepared.stdout.text()).not.toContain('access-secret-token');
  });

  it('preserves an explicit ID and returns exit 3 for resultUnknown', async () => {
    const prepared = await context({
      request: (frame) => ({
        type: 'app-send-result',
        payload: {
          requestId: 'requestId' in frame.payload ? frame.payload.requestId : 'r',
          messageId: 'messageId' in frame.payload ? frame.payload.messageId : 'm',
          status: 'resultUnknown',
          stage: 'result_unknown',
        },
      }),
    });
    const code = await runAppCommand([
      'send', '--peer', 'device-peer', '--message-id', 'stable-id',
      '--subject', 'subject', '--body', 'body',
    ], prepared.context);
    expect(code).toBe(3);
    expect(prepared.frames[0]).toMatchObject({ type: 'app-send-message', payload: { messageId: 'stable-id' } });
    expect(ndjson(prepared.stdout.text())[0]).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'resultUnknown' },
    });
  });

  it('returns structured resultUnknown with the generated ID when the request drops', async () => {
    const prepared = await context({
      request: () => {
        throw new AppCliError('result_unknown', 'local /app connection closed before receipt');
      },
    });
    const code = await runAppCommand([
      'send', '--peer', 'device-peer', '--subject', 'subject', '--body', 'body',
    ], prepared.context);
    expect(code).toBe(3);
    const sent = prepared.frames[0]!;
    const messageId = sent.type === 'app-send-message' ? sent.payload.messageId : '';
    expect(messageId.length).toBeGreaterThan(0);
    expect(ndjson(prepared.stdout.text())[0]).toMatchObject({
      type: 'app-send-result',
      payload: { messageId, status: 'resultUnknown', stage: 'result_unknown' },
    });
  });

  it('emits unrequested app-error and connection close events on the stream', async () => {
    const streamConnection = {
      ready: {
        requestId: 'hello-1',
        protocolVersion: 1,
        deviceId: 'device-local',
        daemonHostId: 'daemon-local',
        capabilities: {},
      },
      async request() {
        throw new AppCliError('internal_error', 'unused');
      },
      close() {},
    } as unknown as AppClientConnection;
    const prepared = await context({
      request: () => streamConnection.ready as never,
      connect: async (options) => {
        options.onEvent?.({
          type: 'app-error',
          payload: { requestId: undefined, messageId: undefined, transferId: undefined, code: 'slow_consumer', stage: 'publish', message: 'slow consumer' },
        });
        options.onEvent?.({
          type: 'app-connection-state',
          payload: { requestId: 'event-1', state: 'disconnected', daemonHostId: 'daemon-local', code: 4008, reason: 'slow_consumer' },
        });
        return streamConnection;
      },
    });
    const code = await runAppCommand(['stream', '--json'], prepared.context);
    expect(code).toBe(1);
    const types = ndjson(prepared.stdout.text()).map((frame) => frame.type);
    expect(types).toContain('app-error');
    expect(types).toContain('app-connection-state');
    const disconnected = ndjson(prepared.stdout.text()).find(
      (frame) => frame.type === 'app-connection-state',
    );
    expect(disconnected).toMatchObject({ payload: { code: 4008, reason: 'slow_consumer' } });
  });

  it('streams a file, rejects invalid files, and covers status/ack/consume', async () => {
    const home = await mkdtemp(join(tmpdir(), 'zterm-cli-file-'));
    roots.push(home);
    const filePath = join(home, 'payload.bin');
    await writeFile(filePath, Buffer.alloc(40_000, 5));
    const prepared = await context({
      request: (frame) => {
        if (frame.type === 'app-send-file-start') {
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              transferId: frame.payload.file.transferId,
              status: 'receiving',
              stage: 'prepared',
              persistedOffset: 0,
            },
          };
        }
        if (frame.type === 'app-send-file-chunk') {
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              transferId: frame.payload.transferId,
              status: 'receiving',
              stage: 'prepared',
              persistedOffset: frame.payload.offset + Buffer.from(frame.payload.dataBase64, 'base64').length,
            },
          };
        }
        return {
          type: 'app-send-result',
          payload: {
            requestId: 'requestId' in frame.payload ? frame.payload.requestId : 'r',
            messageId: 'messageId' in frame.payload ? frame.payload.messageId : 'm',
            transferId: 'transferId' in frame.payload ? frame.payload.transferId : undefined,
            status: 'received',
            stage: 'received',
          },
        };
      },
    });
    const fileCode = await runAppCommand([
      'send-file', '--peer', 'device-peer', '--message-id', 'file-id',
      '--file', filePath, '--subject', 'file',
    ], prepared.context);
    expect(fileCode).toBe(0);
    expect(prepared.frames.filter((frame) => frame.type === 'app-send-file-chunk')).toHaveLength(3);
    expect(ndjson(prepared.stdout.text()).at(-1)).toMatchObject({
      type: 'app-send-result',
      payload: { status: 'received' },
    });

    const invalid = await context({ request: () => { throw new Error('no request'); } });
    const invalidCode = await runAppCommand([
      'send-file', '--peer', 'device-peer', '--file', join(home, 'missing.bin'),
    ], invalid.context);
    expect(invalidCode).toBe(2);
    expect(invalid.stdout.text()).toBe('');
    expect(invalid.stderr.text()).toContain('cannot read file');
    expect(invalid.stderr.text()).not.toContain('cli-secret-token');

    const settle = await context({
      request: (frame) => ({
        type: 'app-status-result',
        payload: {
          requestId: 'requestId' in frame.payload ? frame.payload.requestId : 'r',
          messageId: 'messageId' in frame.payload ? frame.payload.messageId : 'm',
          found: true,
          state: frame.type === 'app-consume' ? 'consumed' : 'delivered',
        },
      }),
    });
    expect(await runAppCommand(['ack', '--message-id', 'm1'], settle.context)).toBe(0);
    expect(await runAppCommand(['consume', '--message-id', 'm1'], settle.context)).toBe(0);
    expect(await runAppCommand(['status', '--message-id', 'm1'], settle.context)).toBe(0);
    expect(settle.frames.map((frame) => frame.type)).toEqual(['app-ack', 'app-consume', 'app-status']);
  });

  it('runs stream commands from NDJSON stdin and keeps output machine-readable', async () => {
    const prepared = await context({
      stdin: [
        JSON.stringify({ type: 'ack', messageId: 'm1' }),
        JSON.stringify({ type: 'status', messageId: 'm1' }),
        '',
      ].join('\n'),
      request: (frame) => ({
        type: 'app-status-result',
        payload: {
          requestId: 'requestId' in frame.payload ? frame.payload.requestId : 'r',
          messageId: 'messageId' in frame.payload ? frame.payload.messageId : 'm',
          found: true,
          state: frame.type === 'app-ack' ? 'delivered' : 'consumed',
        },
      }),
    });
    const code = await runAppCommand(['stream', '--json'], prepared.context);
    expect(code).toBe(1);
    const frames = ndjson(prepared.stdout.text());
    expect(frames[0]).toMatchObject({ type: 'app-ready', payload: { requestId: 'hello-1' } });
    expect(frames.map((frame) => frame.type)).toEqual(['app-ready', 'app-status-result', 'app-status-result']);
    expect(prepared.stderr.text()).toBe('');
  });

  it('emits structured resultUnknown with the original messageId when a stream send drops before receipt', async () => {
    const prepared = await context({
      stdin: JSON.stringify({ type: 'send', peer: 'device-peer', subject: 'subject', body: 'body' }),
      request: () => {
        throw new AppCliError('result_unknown', 'local /app connection closed before receipt');
      },
    });
    const code = await runAppCommand(['stream', '--json'], prepared.context);
    expect(code).toBe(3);
    const frames = ndjson(prepared.stdout.text());
    const result = frames.at(-1);
    expect(result).toMatchObject({ type: 'app-send-result', payload: { status: 'resultUnknown', stage: 'result_unknown' } });
    const sent = prepared.frames[0]!;
    const originalMessageId = sent.type === 'app-send-message' ? sent.payload.messageId : '';
    expect(originalMessageId.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ payload: { messageId: originalMessageId } });
  });

  it('emits structured resultUnknown with the original transferId when a stream send-file drops before receipt', async () => {
    const home = await mkdtemp(join(tmpdir(), 'zterm-cli-stream-file-'));
    roots.push(home);
    const filePath = join(home, 'payload.bin');
    await writeFile(filePath, Buffer.alloc(16));
    const prepared = await context({
      stdin: JSON.stringify({ type: 'send-file', peer: 'device-peer', file: filePath, subject: 'file' }),
      request: () => {
        throw new AppCliError('result_unknown', 'local /app connection closed before receipt');
      },
    });
    const code = await runAppCommand(['stream', '--json'], prepared.context);
    expect(code).toBe(3);
    const frames = ndjson(prepared.stdout.text());
    const result = frames.at(-1);
    expect(result).toMatchObject({ type: 'app-send-result', payload: { status: 'resultUnknown', stage: 'result_unknown' } });
    const sent = prepared.frames[0]!;
    const originalTransferId = sent.type === 'app-send-file-start' ? sent.payload.file.transferId : '';
    expect(originalTransferId.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ payload: { transferId: originalTransferId, messageId: originalTransferId } });
  });

  it('exits 3 when a stream send receives a normal app-send-result with status resultUnknown', async () => {
    const prepared = await context({
      stdin: JSON.stringify({ type: 'send', peer: 'device-peer', subject: 'subject', body: 'body' }),
      request: (frame) => {
        if (frame.type === 'app-send-message') {
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              status: 'resultUnknown',
              stage: 'result_unknown',
            },
          };
        }
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'invalid_state', stage: 'cli', message: 'unexpected frame' }),
        };
      },
    });
    const code = await runAppCommand(['stream', '--json'], prepared.context);
    expect(code, 'stream send should exit 3 on resultUnknown').toBe(3);
    const frames = ndjson(prepared.stdout.text());
    const result = frames.at(-1);
    expect(result).toMatchObject({ type: 'app-send-result', payload: { status: 'resultUnknown', stage: 'result_unknown' } });
    const sent = prepared.frames[0]!;
    const originalMessageId = sent.type === 'app-send-message' ? sent.payload.messageId : '';
    expect(originalMessageId.length).toBeGreaterThan(0);
    expect(result).toMatchObject({ payload: { messageId: originalMessageId } });
    // No second command is read once resultUnknown forces exit 3.
    expect(prepared.frames.length).toBe(1);
  });

  it('exits 3 when a stream send-file start returns resultUnknown (no chunk/commit) for empty and non-empty files', async () => {
    for (const [label, bytes] of [['empty', 0], ['non-empty', 48_000]] as const) {
      const home = await mkdtemp(join(tmpdir(), 'zterm-cli-stream-start-unknown-'));
      roots.push(home);
      const filePath = join(home, 'payload.bin');
      await writeFile(filePath, Buffer.alloc(bytes));
      const prepared = await context({
        stdin: JSON.stringify({ type: 'send-file', peer: 'device-peer', file: filePath, subject: 'file', messageId: `${label}-id` }),
        request: (frame) => {
          if (frame.type === 'app-send-file-start') {
            return {
              type: 'app-send-result',
              payload: {
                requestId: frame.payload.requestId,
                messageId: frame.payload.messageId,
                transferId: frame.payload.file.transferId,
                status: 'resultUnknown',
                stage: 'result_unknown',
              },
            };
          }
          return {
            type: 'app-error',
            payload: appErrorPayload({ code: 'invalid_state', stage: 'file-chunk', message: 'no active transfer', messageId: 'messageId' in frame.payload ? frame.payload.messageId : undefined, transferId: 'transferId' in frame.payload ? frame.payload.transferId : undefined }),
          };
        },
      });
      const code = await runAppCommand(['stream', '--json'], prepared.context);
      expect(code, `${label} stream file should exit 3`).toBe(3);
      const frames = ndjson(prepared.stdout.text());
      const last = frames.at(-1);
      expect(last, `${label} stream file should end on structured resultUnknown`).toMatchObject({
        type: 'app-send-result',
        payload: { status: 'resultUnknown', stage: 'result_unknown' },
      });
      const start = prepared.frames[0]!;
      const originalTransferId = start.type === 'app-send-file-start' ? start.payload.file.transferId : '';
      expect(originalTransferId.length).toBeGreaterThan(0);
      expect(last).toMatchObject({ payload: { transferId: originalTransferId, messageId: originalTransferId } });
      // No chunk or commit request may follow a resultUnknown start.
      expect(prepared.frames.filter((frame) => frame.type !== 'app-send-file-start')).toHaveLength(0);
      expect(JSON.stringify(prepared.stdout.text())).not.toContain('invalid_state');
    }
  });

  it('returns structured resultUnknown (exit 3) when file-start reports resultUnknown with no chunk/commit fallback', async () => {
    for (const [label, bytes] of [['empty', 0], ['non-empty', 48_000]] as const) {
      const home = await mkdtemp(join(tmpdir(), 'zterm-cli-start-unknown-'));
      roots.push(home);
      const filePath = join(home, 'payload.bin');
      await writeFile(filePath, Buffer.alloc(bytes));
      const prepared = await context({
        request: (frame) => {
          if (frame.type === 'app-send-file-start') {
            return {
              type: 'app-send-result',
              payload: {
                requestId: frame.payload.requestId,
                messageId: frame.payload.messageId,
                transferId: frame.payload.file.transferId,
                status: 'resultUnknown',
                stage: 'result_unknown',
              },
            };
          }
          return {
            type: 'app-error',
            payload: appErrorPayload({ code: 'invalid_state', stage: 'file-chunk', message: 'no active transfer', messageId: 'messageId' in frame.payload ? frame.payload.messageId : undefined, transferId: 'transferId' in frame.payload ? frame.payload.transferId : undefined }),
          };
        },
      });
      const code = await runAppCommand([
        'send-file', '--peer', 'device-peer', '--message-id', `${label}-id`,
        '--file', filePath, '--subject', 'file',
      ], prepared.context);
      expect(code, `${label} file should exit 3`).toBe(3);
      const last = ndjson(prepared.stdout.text()).at(-1);
      expect(last, `${label} file should end on structured resultUnknown`).toMatchObject({
        type: 'app-send-result',
        payload: { status: 'resultUnknown', stage: 'result_unknown' },
      });
      // The downstream invalid_state must not overwrite the start result.
      expect(JSON.stringify(prepared.stdout.text())).not.toContain('invalid_state');
    }
  });

  it('exits 3 and keeps the original resultUnknown frame when a stream send-file chunk reports resultUnknown (no follow-up chunk/commit)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'zterm-cli-chunk-unknown-'));
    roots.push(home);
    const filePath = join(home, 'payload.bin');
    // 48000B = three chunks; a resultUnknown on the first chunk must stop the transfer.
    await writeFile(filePath, Buffer.alloc(48_000, 7));
    const prepared = await context({
      stdin: JSON.stringify({ type: 'send-file', peer: 'device-peer', file: filePath, subject: 'file', messageId: 'chunk-unknown-id' }),
      request: (frame) => {
        if (frame.type === 'app-send-file-start') {
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              transferId: frame.payload.file.transferId,
              status: 'receiving',
              stage: 'prepared',
              persistedOffset: 0,
            },
          };
        }
        if (frame.type === 'app-send-file-chunk') {
          // The remote dropped the connection mid-chunk: the daemon returns the original
          // app-send-result with status resultUnknown and no persistedOffset
          // (daemon-app-messaging-runtime.ts:757). This frame must be preserved verbatim.
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              transferId: frame.payload.transferId,
              status: 'resultUnknown',
              stage: 'result_unknown',
            },
          };
        }
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'invalid_state', stage: 'file-commit', message: 'unexpected follow-up request' }),
        };
      },
    });
    const code = await runAppCommand(['stream', '--json'], prepared.context);
    expect(code, 'stream send-file chunk resultUnknown must exit 3').toBe(3);
    const frames = ndjson(prepared.stdout.text());
    const last = frames.at(-1);
    // The daemon's original resultUnknown frame survives unchanged (not rewritten to app-error).
    expect(last, 'stream send-file chunk resultUnknown should end on the original app-send-result').toMatchObject({
      type: 'app-send-result',
      payload: { status: 'resultUnknown', stage: 'result_unknown' },
    });
    expect(last).toMatchObject({ payload: { transferId: 'chunk-unknown-id', messageId: 'chunk-unknown-id' } });
    // Exactly one chunk was attempted; a resultUnknown chunk must not trigger more chunks or a commit.
    expect(prepared.frames.filter((frame) => frame.type === 'app-send-file-chunk')).toHaveLength(1);
    expect(prepared.frames.filter((frame) => frame.type === 'app-send-file-commit')).toHaveLength(0);
    expect(prepared.frames.filter((frame) => frame.type !== 'app-send-file-start')).toHaveLength(1);
    // Only the single stdin command was read before resultUnknown forced the stream to stop.
    expect(prepared.frames.filter((frame) => frame.type === 'app-send-file-start')).toHaveLength(1);
    expect(JSON.stringify(prepared.stdout.text())).not.toContain('invalid_state');
  });

  it('exits 3 and keeps the original resultUnknown frame when a one-shot send-file chunk reports resultUnknown', async () => {
    const home = await mkdtemp(join(tmpdir(), 'zterm-cli-chunk-unknown-oneshot-'));
    roots.push(home);
    const filePath = join(home, 'payload.bin');
    await writeFile(filePath, Buffer.alloc(48_000, 7));
    const prepared = await context({
      request: (frame) => {
        if (frame.type === 'app-send-file-start') {
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              transferId: frame.payload.file.transferId,
              status: 'receiving',
              stage: 'prepared',
              persistedOffset: 0,
            },
          };
        }
        if (frame.type === 'app-send-file-chunk') {
          return {
            type: 'app-send-result',
            payload: {
              requestId: frame.payload.requestId,
              messageId: frame.payload.messageId,
              transferId: frame.payload.transferId,
              status: 'resultUnknown',
              stage: 'result_unknown',
            },
          };
        }
        return {
          type: 'app-error',
          payload: appErrorPayload({ code: 'invalid_state', stage: 'file-commit', message: 'unexpected follow-up request' }),
        };
      },
    });
    const code = await runAppCommand([
      'send-file', '--peer', 'device-peer', '--message-id', 'chunk-unknown-oneshot-id',
      '--file', filePath, '--subject', 'file',
    ], prepared.context);
    expect(code, 'one-shot send-file chunk resultUnknown must exit 3').toBe(3);
    const last = ndjson(prepared.stdout.text()).at(-1);
    expect(last, 'one-shot send-file chunk resultUnknown should emit the original app-send-result').toMatchObject({
      type: 'app-send-result',
      payload: { status: 'resultUnknown', stage: 'result_unknown', messageId: 'chunk-unknown-oneshot-id', transferId: 'chunk-unknown-oneshot-id' },
    });
    expect(prepared.frames.filter((frame) => frame.type === 'app-send-file-chunk')).toHaveLength(1);
    expect(prepared.frames.filter((frame) => frame.type === 'app-send-file-commit')).toHaveLength(0);
    expect(JSON.stringify(prepared.stdout.text())).not.toContain('invalid_state');
  });
});
