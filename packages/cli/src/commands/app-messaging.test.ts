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
});
