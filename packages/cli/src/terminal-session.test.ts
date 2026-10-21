import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  TerminalInputAckPayload,
  TerminalMuxChannelClientMessage,
  TerminalMuxChannelServerMessage,
} from '../../shared/src/connection/protocol.js';
import type {
  CompactIndexedLine,
  TerminalBufferPayload,
} from '../../shared/src/connection/types.js';
import {
  SharedConfigStore,
} from '../../shared/src/node/shared-config.js';
import {
  SessionConnectionError,
  type SessionConnection,
  type SessionConnectionEvent,
  type SessionOpenExistingInput,
  type SessionChannel,
} from './connection.js';
import type {
  CliSlotBinding,
} from './slot-store.js';
import {
  runTerminalSession,
  type TerminalSessionIo,
} from './terminal-session.js';

class FakeStdin extends EventEmitter {
  isRaw = false;
  rawModes: boolean[] = [];

  setRawMode(value: boolean) {
    this.isRaw = value;
    this.rawModes.push(value);
  }

  pause() {
    return this;
  }

  resume() {
    return this;
  }
}

class FakeStdout extends EventEmitter {
  columns = 80;
  rows = 24;
  accepted = true;
  writes: string[] = [];

  write(value: string) {
    this.writes.push(value);
    return this.accepted;
  }

  resize(columns: number, rows = this.rows) {
    this.columns = columns;
    this.rows = rows;
    this.emit('resize');
  }

  text() {
    return this.writes.join('');
  }
}

interface FakeConnectionOptions {
  channelId?: string;
  beforeOpenReturns?: readonly TerminalMuxChannelServerMessage[];
  openError?: unknown;
}

class FakeConnection {
  readonly channelId: string;
  readonly sent: TerminalMuxChannelClientMessage[] = [];
  readonly channel: SessionChannel;
  openInput: SessionOpenExistingInput | null = null;
  closeReason: string | null = null;
  private listener: ((event: SessionConnectionEvent) => void) | null = null;
  private readonly beforeOpenReturns: readonly TerminalMuxChannelServerMessage[];
  private readonly openError: unknown;

  constructor(options: FakeConnectionOptions = {}) {
    this.channelId = options.channelId ?? 'channel-1';
    this.beforeOpenReturns = options.beforeOpenReturns ?? [];
    this.openError = options.openError;
    this.channel = {
      id: this.channelId,
      sessionName: BINDING.session.name,
      stableId: BINDING.session.stableId,
      send: (message) => {
        this.sent.push(message);
      },
      sendBinary: () => undefined,
      close: () => undefined,
    };
  }

  onEvent(listener: (event: SessionConnectionEvent) => void) {
    this.listener = listener;
    return () => {
      if (this.listener === listener) {
        this.listener = null;
      }
    };
  }

  async openExisting(input: SessionOpenExistingInput) {
    this.openInput = input;
    if (this.openError) {
      throw this.openError;
    }
    this.emit({
      type: 'channel-opened',
      channelId: this.channelId,
      sessionName: BINDING.session.name,
      stableId: BINDING.session.stableId,
      capabilities: { reliableInput: { version: 1 } },
    });
    for (const message of this.beforeOpenReturns) {
      this.emit({
        type: 'channel-message',
        channelId: this.channelId,
        message,
      });
    }
    return this.channel;
  }

  close(reason = 'client_close') {
    this.closeReason = reason;
  }

  emit(event: SessionConnectionEvent) {
    this.listener?.(event);
  }

  inputMessages() {
    return this.sent.filter((message) => message.type === 'input');
  }

  acknowledge(messageIndex = 0, overrides: Partial<TerminalInputAckPayload> = {}) {
    const message = this.inputMessages()[messageIndex];
    if (!message || typeof message.payload === 'string') {
      throw new Error('reliable input message is missing');
    }
    this.emit({
      type: 'input-ack',
      channelId: this.channelId,
      payload: {
        version: 1,
        seq: message.payload.seq,
        accepted: true,
        bytes: Buffer.byteLength(message.payload.data, 'utf8'),
        ...overrides,
      },
    });
  }
}

const BINDING: CliSlotBinding = {
  account: {
    relayBaseUrl: 'https://relay.example.test/zterm/',
    userId: 'user-1',
  },
  server: {
    deviceId: 'device-1',
    daemonHostId: 'daemon-1',
    displayName: 'Workstation',
  },
  session: {
    backend: 'tmux',
    stableId: 'tmux-stable-1',
    name: 'work',
  },
  widthMode: 'adaptive-phone',
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function createStore() {
  const homeDir = mkdtempSync(join(tmpdir(), 'zterm-terminal-session-'));
  const store = new SharedConfigStore({ homeDir });
  cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
  return store;
}

async function writeAuth(store: SharedConfigStore, loginId = 'login-1') {
  await store.update((config) => {
    config.zterm = {
      cli: {
        server: { relayBaseUrl: BINDING.account.relayBaseUrl },
        authGeneration: 1,
        auth: {
          loginId,
          userId: BINDING.account.userId,
          username: 'jason',
          accessToken: 'access-token-secret',
          authenticatedAt: '2026-10-20T00:00:00.000Z',
        },
      },
    };
    return { value: undefined, changed: true };
  });
}

function line(index: number, text: string): CompactIndexedLine {
  return { i: index, t: text };
}

function bufferPayload(
  text: string,
  revision = 1,
  startIndex = 0,
): TerminalBufferPayload {
  return {
    revision,
    startIndex,
    endIndex: startIndex + 1,
    availableStartIndex: 0,
    availableEndIndex: startIndex + 1,
    cols: 80,
    rows: 24,
    cursorKeysApp: false,
    cursor: null,
    lines: [line(startIndex, text)],
  };
}

function visibleText(value: string) {
  return value.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function ioFixture() {
  const stdin = new FakeStdin();
  const stdout = new FakeStdout();
  return {
    stdin,
    stdout,
    io: {
      stdin,
      stdout,
    } as unknown as TerminalSessionIo,
  };
}

async function startSession(options: {
  binding?: CliSlotBinding;
  connection?: FakeConnection;
  store?: SharedConfigStore;
  io?: ReturnType<typeof ioFixture>;
}) {
  const store = options.store ?? createStore();
  if (!options.store) {
    await writeAuth(store);
  }
  const connection = options.connection ?? new FakeConnection();
  const terminalIo = options.io ?? ioFixture();
  const result = runTerminalSession({
    store,
    binding: options.binding ?? BINDING,
    connection: connection as unknown as SessionConnection,
    io: terminalIo.io,
  });
  await vi.waitFor(() => {
    expect(connection.openInput).not.toBeNull();
    expect(
      connection.sent.some(
        (message) => message.type === 'body-subscription',
      ),
    ).toBe(true);
  });
  return { connection, result, store, ...terminalIo };
}

describe('terminal-session public consumer contract', () => {
  it('shows a typed server channel error without displaying the server reason', async () => {
    const terminalIo = ioFixture();
    const store = createStore();
    await writeAuth(store);
    const connection = new FakeConnection({
      openError: new SessionConnectionError('secret server reason', {
        stage: 'channel-open',
        code: 'channel_closed',
        serverCode: 'session_identity_mismatch',
        channelId: 'channel-1',
      }),
    });

    const result = await runTerminalSession({
      store,
      binding: BINDING,
      connection: connection as unknown as SessionConnection,
      io: terminalIo.io,
    });

    expect(result).toEqual({
      exitCode: 1,
      message: '会话打开失败（session_identity_mismatch）。',
    });
    expect(result.message).not.toContain('secret server reason');
    expect(terminalIo.stdin.rawModes).toEqual([true, false]);
  });

  it('registers the mirror before early business messages and does not repaint on metadata', async () => {
    const connection = new FakeConnection({
      beforeOpenReturns: [{
        type: 'buffer-sync',
        payload: bufferPayload('early-frame'),
      }],
    });
    const session = await startSession({ connection });

    await vi.waitFor(() => {
      expect(visibleText(session.stdout.text())).toContain('early-frame');
    });
    expect(connection.openInput).toEqual({
      sessionName: BINDING.session.name,
      backend: BINDING.session.backend,
      stableId: BINDING.session.stableId,
      cols: 80,
      widthMode: 'adaptive-phone',
      bodySubscribed: true,
    });

    const writesBeforeMetadata = session.stdout.writes.length;
    connection.emit({
      type: 'channel-message',
      channelId: connection.channelId,
      message: {
        type: 'buffer-head',
        payload: {
          sessionId: connection.channelId,
          revision: 1,
          latestEndIndex: 1,
          availableStartIndex: 0,
          availableEndIndex: 1,
        },
      },
    });
    await Promise.resolve();
    expect(session.stdout.writes).toHaveLength(writesBeforeMetadata);

    session.stdin.emit('data', Buffer.from([0x1d, 0x71]));
    await expect(session.result).resolves.toEqual({ exitCode: 0 });
    expect(connection.closeReason).not.toBeNull();
  });

  it('sends only paste content and treats prefix close as local', async () => {
    const session = await startSession({});

    session.stdin.emit('data', Buffer.from('\x1b[200~', 'binary'));
    session.stdin.emit('data', Buffer.from('hello', 'utf8'));
    session.stdin.emit('data', Buffer.from('\x1b[201~', 'binary'));

    await vi.waitFor(() => {
      expect(session.connection.inputMessages()).toHaveLength(1);
    });
    const paste = session.connection.inputMessages()[0];
    expect(paste?.type).toBe('input');
    if (paste?.type === 'input' && typeof paste.payload !== 'string') {
      expect(paste.payload.data).toBe('hello');
    }
    session.connection.acknowledge();
    await vi.waitFor(() => {
      expect(session.connection.inputMessages()).toHaveLength(1);
    });

    session.stdin.emit('data', Buffer.from([0x1d, 0x71]));
    await expect(session.result).resolves.toEqual({ exitCode: 0 });
    expect(session.connection.inputMessages()).toHaveLength(1);
    expect(session.stdin.rawModes).toEqual([true, false]);
    expect(session.stdout.text()).toContain('\x1b[?1049l');
  });

  it('flushes an EOF prefix byte and waits for its ACK without inventing Ctrl+D', async () => {
    const session = await startSession({});

    session.stdin.emit('data', Buffer.from([0x1d]));
    session.stdin.emit('end');

    await vi.waitFor(() => {
      expect(session.connection.inputMessages()).toHaveLength(1);
    });
    const input = session.connection.inputMessages()[0];
    if (input?.type !== 'input' || typeof input.payload === 'string') {
      throw new Error('expected reliable input payload');
    }
    expect(input.payload.data).toBe('\u001d');
    expect(input.payload.data).not.toContain('\u0004');

    session.connection.acknowledge();
    await expect(session.result).resolves.toEqual({ exitCode: 0 });
  });

  it('stops after an uncertain NACK and never replays or sends queued input', async () => {
    const session = await startSession({});

    session.stdin.emit('data', Buffer.from('a'));
    session.stdin.emit('data', Buffer.from('b'));
    await vi.waitFor(() => {
      expect(session.connection.inputMessages()).toHaveLength(1);
    });
    expect(session.connection.inputMessages()[0]?.type).toBe('input');

    session.connection.acknowledge(0, {
      accepted: false,
      bytes: 1,
      error: 'input_stale_transport',
    });
    const result = await session.result;

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('结果未确认');
    expect(result.message).toContain('input_stale_transport');
    expect(session.connection.inputMessages()).toHaveLength(1);
    expect(session.stdin.rawModes).toEqual([true, false]);
  });

  it('checks loginId before remote dispatch and closes after logout', async () => {
    const session = await startSession({});

    await session.store.update((config) => {
      const zterm = config.zterm as { cli?: Record<string, unknown> };
      const cli = zterm.cli!;
      cli.authGeneration = 2;
      delete cli.auth;
      return { value: undefined, changed: true };
    });
    session.stdin.emit('data', Buffer.from('blocked'));
    const result = await session.result;

    expect(result.exitCode).toBe(1);
    expect(result.message).toContain('zterm login');
    expect(session.connection.inputMessages()).toHaveLength(0);
  });

  it('uses one adaptive-phone resize after the App debounce window', async () => {
    const session = await startSession({});

    session.stdout.resize(100, 30);
    session.stdout.resize(110, 31);
    session.stdout.resize(120, 32);
    await vi.waitFor(() => {
      expect(
        session.connection.sent.filter((message) => message.type === 'resize'),
      ).toEqual([{
        type: 'resize',
        payload: {
          cols: 120,
          rows: 32,
          widthMode: 'adaptive-phone',
        },
      }]);
    }, { timeout: 500 });

    session.stdin.emit('data', Buffer.from([0x1d, 0x71]));
    await expect(session.result).resolves.toEqual({ exitCode: 0 });
  }, 2_000);

  it('keeps mirror-fixed geometry local and restores the terminal on EPIPE', async () => {
    const fixed = {
      ...BINDING,
      widthMode: 'mirror-fixed' as const,
    };
    const session = await startSession({ binding: fixed });

    expect(session.connection.openInput).toEqual({
      sessionName: BINDING.session.name,
      backend: BINDING.session.backend,
      stableId: BINDING.session.stableId,
      widthMode: 'mirror-fixed',
      bodySubscribed: true,
    });

    session.stdout.resize(120, 32);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(
      session.connection.sent.filter((message) => message.type === 'resize'),
    ).toHaveLength(0);

    session.stdout.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
    const result = await session.result;
    expect(result.exitCode).toBe(1);
    expect(session.stdin.rawModes).toEqual([true, false]);
    expect(session.stdout.text()).toContain('\x1b[?1049l');
  });

  it('releases a blocked stdout drain waiter when the session closes', async () => {
    const terminalIo = ioFixture();
    terminalIo.stdout.accepted = false;
    const connection = new FakeConnection({
      beforeOpenReturns: [{
        type: 'buffer-sync',
        payload: bufferPayload('blocked-frame'),
      }],
    });
    const session = await startSession({ connection, io: terminalIo });

    expect(session.stdout.listenerCount('drain')).toBe(1);

    session.stdin.emit('data', Buffer.from([0x1d, 0x71]));
    await expect(session.result).resolves.toEqual({ exitCode: 0 });
    expect(session.stdout.listenerCount('drain')).toBe(0);
    expect(session.stdin.rawModes).toEqual([true, false]);
  });
});
