import { describe, expect, it, vi } from 'vitest';
import type {
  TerminalAttachPayload,
  TerminalTransportConnection,
  TerminalTransportSubscriber,
} from './terminal-runtime-types';
import type { TerminalSessionIdentityResolution } from './terminal-source-adapter';
import { createTerminalMuxChannelRuntime } from './terminal-mux-channel-runtime';

const stableId = 'tmux:v1:opaque-expected';
const resolvedSession = {
  identity: {
    backend: 'tmux' as const,
    sessionName: 'work',
    stableId,
  },
  target: {
    backend: 'tmux' as const,
    sessionName: 'work',
    stableId,
    socketPath: '/tmp/zterm-exact/default',
    serverPid: '900',
    sessionId: '$4',
    createdAt: 100,
  },
};

function createConnection(): TerminalTransportConnection {
  return {
    transportId: 'transport-identity',
    transport: {
      kind: 'ws',
      readyState: 1,
      sendText: vi.fn(),
      close: vi.fn(),
    },
    closeTransport: vi.fn(),
    requestOrigin: 'test',
    role: 'control',
    boundSubscriberId: null,
    muxVersion: 1,
    muxChannels: new Map(),
  };
}

type ExistingSessionResolver = (
  stableId: string,
  backend: 'tmux' | 'herdr',
  requestedSessionName?: string,
) => TerminalSessionIdentityResolution;

function createHarness(
  resolveExistingSession: ExistingSessionResolver,
) {
  const sessions = new Map<string, TerminalTransportSubscriber>();
  const frames: unknown[] = [];
  const createMuxChannelSubscriber = vi.fn((connection: TerminalTransportConnection, channelId: string) => {
    const subscriber: TerminalTransportSubscriber = {
      id: `${connection.transportId}:${channelId}`,
      transportId: connection.transportId,
      transport: connection.transport,
      sessionName: 'demo',
      backend: 'tmux',
      mirrorKey: null,
      bodySubscribed: true,
      pendingPasteImage: null,
      pendingAttachFile: null,
    };
    sessions.set(subscriber.id, subscriber);
    connection.muxChannels?.set(channelId, subscriber.id);
    return subscriber;
  });
  const bindResolvedSession = vi.fn();
  const attachTmux = vi.fn(async (_subscriber: TerminalTransportSubscriber, _payload: TerminalAttachPayload) => {});
  const runtime = createTerminalMuxChannelRuntime({
    sessions,
    mirrors: new Map(),
    sendTransportMessage: (_transport, message) => frames.push(message),
    createMuxChannelSubscriber,
    ensureMuxChannels: (connection) => {
      connection.muxChannels ||= new Map();
      return connection.muxChannels;
    },
    releaseMuxChannelSubscriber: (connection, channelId) => {
      connection.muxChannels?.delete(channelId);
    },
    sanitizeSessionName: (input?: string) => input?.trim() || 'demo',
    attachTmux,
    closeSession: vi.fn(),
    handleMessage: vi.fn(async () => {}),
    resolveExistingSession,
    bindResolvedSession,
  } as Parameters<typeof createTerminalMuxChannelRuntime>[0]);
  return {
    runtime,
    sessions,
    frames,
    createMuxChannelSubscriber,
    bindResolvedSession,
    attachTmux,
  };
}

describe('terminal mux exact-existing open', () => {
  it('rejects a stale expected identity before creating a channel subscriber or attach', async () => {
    const resolveExistingSession = vi.fn(() => ({
      ok: false as const,
      code: 'session_identity_mismatch' as const,
      message: 'display name now belongs to a different session',
    }));
    const harness = createHarness(resolveExistingSession);
    const connection = createConnection();

    await harness.runtime.handleMuxFrame(connection as never, {
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-stale',
        sessionName: 'work',
        backend: 'tmux',
        expectedSessionIdentity: stableId,
        existingOnly: true,
      },
    });

    expect(resolveExistingSession).toHaveBeenCalledWith(stableId, 'tmux', 'work');
    expect(harness.createMuxChannelSubscriber).not.toHaveBeenCalled();
    expect(harness.bindResolvedSession).not.toHaveBeenCalled();
    expect(harness.attachTmux).not.toHaveBeenCalled();
    expect(harness.sessions.size).toBe(0);
    expect(connection.muxChannels?.size).toBe(0);
    expect(harness.frames).toContainEqual({
      type: 'mux-channel-closed',
      payload: expect.objectContaining({
        channelId: 'channel-stale',
        code: 'session_identity_mismatch',
      }),
    });
  });

  it('binds and attaches the exact resolved socket target and returns its stable id', async () => {
    const resolveExistingSession = vi.fn(() => ({
      ok: true as const,
      session: resolvedSession,
    }));
    const harness = createHarness(resolveExistingSession);
    const connection = createConnection();

    await harness.runtime.handleMuxFrame(connection as never, {
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-exact',
        sessionName: 'work',
        backend: 'tmux',
        expectedSessionIdentity: stableId,
        existingOnly: true,
      },
    });

    const subscriber = harness.sessions.get('transport-identity:channel-exact');
    expect(harness.bindResolvedSession).toHaveBeenCalledWith(resolvedSession);
    expect(harness.createMuxChannelSubscriber).toHaveBeenCalledOnce();
    expect(subscriber).toMatchObject({
      sessionName: 'work',
      backend: 'tmux',
    });
    expect(harness.attachTmux).toHaveBeenCalledWith(subscriber, {
      sessionName: 'work',
      backend: 'tmux',
      cols: undefined,
      rows: undefined,
      widthMode: undefined,
      autoCommand: undefined,
      resolvedSession,
    });
    expect(harness.frames).toContainEqual({
      type: 'mux-channel-opened',
      payload: expect.objectContaining({
        channelId: 'channel-exact',
        sessionName: 'work',
        stableId,
      }),
    });
  });

  it('keeps the legacy open behavior when existingOnly is not set', async () => {
    const resolveExistingSession = vi.fn();
    const harness = createHarness(resolveExistingSession);
    const connection = createConnection();

    await harness.runtime.handleMuxFrame(connection as never, {
      type: 'mux-channel-open',
      payload: {
        channelId: 'channel-legacy',
        sessionName: 'work',
        backend: 'tmux',
      },
    });

    expect(resolveExistingSession).not.toHaveBeenCalled();
    expect(harness.bindResolvedSession).not.toHaveBeenCalled();
    expect(harness.createMuxChannelSubscriber).toHaveBeenCalledOnce();
    expect(harness.attachTmux).toHaveBeenCalledOnce();
  });
});
