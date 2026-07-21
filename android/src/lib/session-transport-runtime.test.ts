import { describe, expect, it } from 'vitest';
import type { Host } from './types';
import {
  buildTransportTargetKey,
  clearSessionSupersededSockets,
  createSessionTransportRuntimeStore,
  ensureSessionTerminalChannel,
  getOpeningSessionTerminalChannelsForTarget,
  getSessionIdForTerminalChannel,
  getSessionTargetTerminalTransport,
  getSessionTargetTerminalMuxReady,
  getSessionTerminalChannel,
  getSessionTargetControlTransport,
  getSessionTargetTransportRuntime,
  getSessionTransportTargetKey,
  getTargetTerminalTransport,
  getTargetControlTransport,
  getTargetTransportRuntime,
  getSessionTransportHost,
  getSessionTransportResource,
  getSessionTransportRuntime,
  getSessionTransportSocket,
  moveSessionTransportSocketToSuperseded,
  removeSessionTransportRuntime,
  removeSessionTerminalChannel,
  setSessionChannelBodySubscribed,
  setSessionTargetTerminalMuxReady,
  setSessionTargetControlTransport,
  setTargetControlTransport,
  setTargetTerminalTransport,
  setSessionTransportSocket,
  updateSessionTerminalChannelState,
  upsertSessionTransportRuntime,
} from './session-transport-runtime';

function makeHost(overrides?: Partial<Host>): Host {
  return {
    id: 'host-1',
    createdAt: 1,
    name: 'conn',
    bridgeHost: '100.64.0.1',
    bridgePort: 3333,
    sessionName: 'alpha',
    authToken: 'token-a',
    authType: 'password',
    tags: [],
    pinned: false,
    ...overrides,
  };
}

function makeSocket(name: string) {
  return {
    name,
    readyState: 1,
    closeCalls: 0,
    send() {},
    close() {
      this.closeCalls += 1;
      this.readyState = 3;
    },
    getDiagnostics() {
      return { transport: 'ws', reason: null };
    },
  };
}

describe('session transport runtime store', () => {
  it('keeps bridgeHost + bridgePort + authToken in the target key truth', () => {
    expect(buildTransportTargetKey(makeHost())).toContain('host=100.64.0.1');
    expect(buildTransportTargetKey(makeHost())).toContain('port=3333');
    expect(buildTransportTargetKey(makeHost())).toContain('auth=token-a');
    expect(buildTransportTargetKey(makeHost({ authToken: 'token-b' }))).not.toBe(buildTransportTargetKey(makeHost()));
    expect(buildTransportTargetKey(makeHost({ bridgePort: 4444 }))).not.toBe(buildTransportTargetKey(makeHost()));
  });

  it('treats direct websocket and relay/webrtc route identities as different transport targets', () => {
    const directOnly = makeHost({
      transportMode: 'websocket',
      tailscaleHost: '100.66.1.82',
      relayHostId: undefined,
      relayEndpointCandidates: [],
    });
    const relayAware = makeHost({
      transportMode: 'auto',
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      tailscaleHost: '100.66.1.82',
      relayEndpointCandidates: [
        {
          id: 'direct:tailscale:mac-studio',
          kind: 'tailscale',
          host: '100.66.1.82',
          port: 3333,
          authRequired: true,
          lastSeenAt: '2026-07-20T00:00:00.000Z',
        },
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-20T00:00:00.000Z',
        },
      ],
    });

    expect(buildTransportTargetKey(relayAware)).not.toBe(buildTransportTargetKey(directOnly));
  });

  it('does not churn target keys when only relay directory lastSeenAt changes', () => {
    const base = makeHost({
      transportMode: 'auto',
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      relayEndpointCandidates: [
        {
          id: 'relay-rtc:mac-studio',
          kind: 'relay-rtc',
          relayHostId: 'mac-studio',
          authRequired: true,
          lastSeenAt: '2026-07-20T00:00:00.000Z',
        },
      ],
    });

    expect(buildTransportTargetKey(base)).toBe(buildTransportTargetKey({
      ...base,
      relayEndpointCandidates: [
        {
          ...base.relayEndpointCandidates![0],
          lastSeenAt: '2026-07-20T00:10:00.000Z',
        },
      ],
    }));
  });

  it('groups same-target sessions under one target runtime while keeping per-session runtime truth', () => {
    const store = createSessionTransportRuntimeStore();

    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    expect(store.targets.size).toBe(1);
    expect(store.targets.values().next().value?.sessionIds).toEqual(['session-1', 'session-2']);
    expect(getSessionTransportRuntime(store, 'session-1')?.targetKey).toBe(getSessionTransportRuntime(store, 'session-2')?.targetKey);
    expect(getSessionTransportTargetKey(store, 'session-1')).toBe(getSessionTransportRuntime(store, 'session-1')?.targetKey);
    expect(getSessionTransportHost(store, 'session-2')?.sessionName).toBe('beta');
    expect(getSessionTargetTransportRuntime(store, 'session-1')).toBe(getSessionTargetTransportRuntime(store, 'session-2'));
  });

  it('keeps one target-level control transport truth shared by same-target sessions', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const controlSocket = makeSocket('control-a');

    setTargetControlTransport(store, targetKey, controlSocket as any);

    expect(getTargetTransportRuntime(store, targetKey)?.controlTransport).toBe(controlSocket);
    expect(getTargetControlTransport(store, targetKey)).toBe(controlSocket);
    expect(getSessionTargetControlTransport(store, 'session-1')).toBe(controlSocket);
    expect(getSessionTargetControlTransport(store, 'session-2')).toBe(controlSocket);
  });

  it('session-side helper can update the shared target control transport without touching per-session sockets', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const sessionSocket = makeSocket('session-a');
    const controlSocket = makeSocket('control-a');

    setSessionTransportSocket(store, 'session-1', sessionSocket as any);
    setSessionTargetControlTransport(store, 'session-2', controlSocket as any);

    expect(getSessionTransportSocket(store, 'session-1')).toBe(sessionSocket);
    expect(getSessionTransportSocket(store, 'session-2')).toBeNull();
    expect(getSessionTargetControlTransport(store, 'session-1')).toBe(controlSocket);
    expect(getSessionTargetControlTransport(store, 'session-2')).toBe(controlSocket);
  });

  it('moves replaced session sockets into superseded truth without affecting siblings', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const socketA = makeSocket('a');
    const socketB = makeSocket('b');
    setSessionTransportSocket(store, 'session-1', socketA as any);
    setSessionTransportSocket(store, 'session-2', socketB as any);

    moveSessionTransportSocketToSuperseded(store, 'session-1');

    expect(getSessionTransportSocket(store, 'session-1')).toBeNull();
    expect(getSessionTransportRuntime(store, 'session-1')?.supersededSockets).toEqual([socketA]);
    expect(getSessionTransportSocket(store, 'session-2')).toBe(socketB);
    expect(getSessionTransportRuntime(store, 'session-2')?.supersededSockets).toEqual([]);
  });

  it('clears superseded sockets and drops empty target runtimes only when the last session leaves', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const socketA = makeSocket('a');
    setSessionTransportSocket(store, 'session-1', socketA as any);
    moveSessionTransportSocketToSuperseded(store, 'session-1');

    expect(clearSessionSupersededSockets(store, 'session-1')).toEqual([socketA]);
    expect(getSessionTransportRuntime(store, 'session-1')?.supersededSockets).toEqual([]);

    removeSessionTransportRuntime(store, 'session-1');
    expect(store.targets.size).toBe(1);
    expect(store.targets.values().next().value?.sessionIds).toEqual(['session-2']);

    removeSessionTransportRuntime(store, 'session-2');
    expect(store.targets.size).toBe(0);
    expect(store.sessions.size).toBe(0);
  });

  it('retains target runtime while control transport exists and drops it only after control closes', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));

    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const controlSocket = makeSocket('control-a');

    setTargetControlTransport(store, targetKey, controlSocket as any);
    removeSessionTransportRuntime(store, 'session-1');

    expect(store.sessions.size).toBe(0);
    expect(store.targets.size).toBe(1);
    expect(getTargetTransportRuntime(store, targetKey)?.controlTransport).toBe(controlSocket);

    setTargetControlTransport(store, targetKey, null);

    expect(getTargetTransportRuntime(store, targetKey)).toBeNull();
    expect(store.targets.size).toBe(0);
  });

  it('drops empty old target on session retarget only when that old target has no control transport', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));

    const oldTargetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const oldControlSocket = makeSocket('old-control');
    setTargetControlTransport(store, oldTargetKey, oldControlSocket as any);

    upsertSessionTransportRuntime(
      store,
      'session-1',
      makeHost({
        bridgeHost: '100.64.0.2',
        authToken: 'token-b',
        sessionName: 'alpha',
      }),
    );

    const newTargetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    expect(newTargetKey).not.toBe(oldTargetKey);
    expect(getTargetTransportRuntime(store, oldTargetKey)?.sessionIds).toEqual([]);
    expect(getTargetTransportRuntime(store, oldTargetKey)?.controlTransport).toBe(oldControlSocket);
    expect(getTargetTransportRuntime(store, newTargetKey)?.sessionIds).toEqual(['session-1']);

    setTargetControlTransport(store, oldTargetKey, null);

    expect(getTargetTransportRuntime(store, oldTargetKey)).toBeNull();
    expect(getTargetTransportRuntime(store, newTargetKey)?.sessionIds).toEqual(['session-1']);
  });

  it('does not carry an active socket across a route target retarget', () => {
    const store = createSessionTransportRuntimeStore();
    const directHost = makeHost({
      sessionName: 'alpha',
      transportMode: 'websocket',
      tailscaleHost: '100.66.1.82',
    });
    const relayAwareHost = makeHost({
      sessionName: 'alpha',
      transportMode: 'auto',
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
      tailscaleHost: '100.66.1.82',
      relayEndpointCandidates: [{
        id: 'relay-rtc:mac-studio',
        kind: 'relay-rtc',
        relayHostId: 'mac-studio',
        authRequired: true,
        lastSeenAt: '2026-07-20T00:00:00.000Z',
      }],
    });
    const directSocket = makeSocket('direct-open');

    upsertSessionTransportRuntime(store, 'session-1', directHost);
    setSessionTransportSocket(store, 'session-1', directSocket as any);
    const oldTargetKey = getSessionTransportTargetKey(store, 'session-1');

    upsertSessionTransportRuntime(store, 'session-1', relayAwareHost);

    const runtime = getSessionTransportRuntime(store, 'session-1');
    const newTargetKey = getSessionTransportTargetKey(store, 'session-1');
    expect(newTargetKey).not.toBe(oldTargetKey);
    expect(runtime?.activeSocket).toBeNull();
    expect(runtime?.supersededSockets).toEqual([directSocket]);
    expect(getSessionTransportSocket(store, 'session-1')).toBeNull();
    expect(getTargetTransportRuntime(store, oldTargetKey!)?.sessionIds || []).not.toContain('session-1');
    expect(getTargetTransportRuntime(store, newTargetKey!)?.sessionIds).toEqual(['session-1']);
  });

  it('preserves the active socket when upserting the same target route', () => {
    const store = createSessionTransportRuntimeStore();
    const socket = makeSocket('same-target-open');

    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    setSessionTransportSocket(store, 'session-1', socket as any);

    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha', name: 'Renamed' }));

    const runtime = getSessionTransportRuntime(store, 'session-1');
    expect(runtime?.activeSocket).toBe(socket);
    expect(runtime?.supersededSockets).toEqual([]);
  });

  it('keeps one target-level terminal transport shared by same-target channels', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const targetSocket = makeSocket('target-terminal');
    setTargetTerminalTransport(store, targetKey, targetSocket as any);

    const channelA = ensureSessionTerminalChannel(store, 'session-1', { channelId: 'channel-a', now: 10 });
    const channelB = ensureSessionTerminalChannel(store, 'session-2', { channelId: 'channel-b', now: 20 });

    expect(getTargetTerminalTransport(store, targetKey)).toBe(targetSocket);
    expect(getSessionTargetTerminalTransport(store, 'session-1')).toBe(targetSocket);
    expect(getSessionTargetTerminalTransport(store, 'session-2')).toBe(targetSocket);
    expect(channelA).toMatchObject({
      channelId: 'channel-a',
      sessionId: 'session-1',
      sessionName: 'alpha',
      state: 'opening',
      bodySubscribed: true,
      openedAt: 10,
    });
    expect(channelB).toMatchObject({
      channelId: 'channel-b',
      sessionId: 'session-2',
      sessionName: 'beta',
      state: 'opening',
      bodySubscribed: true,
      openedAt: 20,
    });
    expect(getTargetTransportRuntime(store, targetKey)?.channels.size).toBe(2);
  });

  it('exposes an open mux target transport as the effective session resource without changing legacy active socket truth', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const targetSocket = makeSocket('target-terminal');

    setTargetTerminalTransport(store, targetKey, targetSocket as any);
    ensureSessionTerminalChannel(store, 'session-1', { channelId: 'channel-a' });

    expect(getSessionTransportResource(store, 'session-1').socket).toBeNull();
    expect(getSessionTransportSocket(store, 'session-1')).toBeNull();

    setSessionTargetTerminalMuxReady(store, 'session-1', true);

    const resource = getSessionTransportResource(store, 'session-1');
    expect(resource.socket).toBe(targetSocket);
    expect(resource.terminalSocket).toBe(targetSocket);
    expect(resource.socketState).toBe('open');
    expect(getSessionTransportSocket(store, 'session-1')).toBeNull();
  });

  it('keeps channel state and body subscription isolated per session', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));
    ensureSessionTerminalChannel(store, 'session-1', { channelId: 'channel-a' });
    ensureSessionTerminalChannel(store, 'session-2', { channelId: 'channel-b' });

    updateSessionTerminalChannelState(store, 'session-1', 'open');
    setSessionChannelBodySubscribed(store, 'session-1', false);

    expect(getSessionTerminalChannel(store, 'session-1')).toMatchObject({
      channelId: 'channel-a',
      state: 'open',
      bodySubscribed: false,
    });
    expect(getSessionTerminalChannel(store, 'session-2')).toMatchObject({
      channelId: 'channel-b',
      state: 'opening',
      bodySubscribed: true,
    });
    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    expect(getSessionIdForTerminalChannel(store, targetKey, 'channel-a')).toBe('session-1');
    expect(getSessionIdForTerminalChannel(store, targetKey, 'channel-b')).toBe('session-2');
    expect(getOpeningSessionTerminalChannelsForTarget(store, targetKey).map((channel) => channel.channelId)).toEqual(['channel-b']);
  });

  it('can prioritize the anchor session when reading opening channels for a shared mux target', () => {
    const store = createSessionTransportRuntimeStore();
    const host = makeHost({ sessionName: 'alpha' });
    upsertSessionTransportRuntime(store, 'session-1', host);
    upsertSessionTransportRuntime(store, 'session-2', host);
    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    ensureSessionTerminalChannel(store, 'session-1', { channelId: 'channel-a' });
    ensureSessionTerminalChannel(store, 'session-2', { channelId: 'channel-b' });

    expect(getOpeningSessionTerminalChannelsForTarget(store, targetKey, 'session-2').map((channel) => channel.channelId)).toEqual([
      'channel-b',
      'channel-a',
    ]);
  });

  it('removes a closed session channel without closing sibling channels or target transport truth', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));
    const targetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const targetSocket = makeSocket('target-terminal');
    setTargetTerminalTransport(store, targetKey, targetSocket as any);
    ensureSessionTerminalChannel(store, 'session-1', { channelId: 'channel-a' });
    ensureSessionTerminalChannel(store, 'session-2', { channelId: 'channel-b' });

    const removed = removeSessionTerminalChannel(store, 'session-1');

    expect(removed?.channelId).toBe('channel-a');
    expect(getSessionTerminalChannel(store, 'session-1')).toBeNull();
    expect(getSessionTerminalChannel(store, 'session-2')?.channelId).toBe('channel-b');
    expect(getTargetTransportRuntime(store, targetKey)?.channels.size).toBe(1);
    expect(getTargetTerminalTransport(store, targetKey)).toBe(targetSocket);
  });

  it('drops a session channel on route retarget without deleting the old target transport', () => {
    const store = createSessionTransportRuntimeStore();
    const oldHost = makeHost({ sessionName: 'alpha', transportMode: 'websocket' });
    const newHost = makeHost({
      sessionName: 'alpha',
      transportMode: 'auto',
      daemonHostId: 'mac-studio',
      relayHostId: 'mac-studio',
    });

    upsertSessionTransportRuntime(store, 'session-1', oldHost);
    const oldTargetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    const oldTargetSocket = makeSocket('old-target-terminal');
    setTargetTerminalTransport(store, oldTargetKey, oldTargetSocket as any);
    ensureSessionTerminalChannel(store, 'session-1', { channelId: 'old-channel' });

    upsertSessionTransportRuntime(store, 'session-1', newHost);

    const newTargetKey = getSessionTransportRuntime(store, 'session-1')!.targetKey;
    expect(newTargetKey).not.toBe(oldTargetKey);
    expect(getTargetTransportRuntime(store, oldTargetKey)?.channels.size).toBe(0);
    expect(getTargetTerminalTransport(store, oldTargetKey)).toBe(oldTargetSocket);
    expect(getSessionTerminalChannel(store, 'session-1')).toBeNull();
    expect(getTargetTransportRuntime(store, newTargetKey)?.sessionIds).toEqual(['session-1']);
  });

  it('keeps mux-ready truth on the target runtime instead of each session', () => {
    const store = createSessionTransportRuntimeStore();
    upsertSessionTransportRuntime(store, 'session-1', makeHost({ sessionName: 'alpha' }));
    upsertSessionTransportRuntime(store, 'session-2', makeHost({ id: 'host-2', sessionName: 'beta' }));

    expect(getSessionTargetTerminalMuxReady(store, 'session-1')).toBe(false);
    setSessionTargetTerminalMuxReady(store, 'session-1', true);

    expect(getSessionTargetTerminalMuxReady(store, 'session-1')).toBe(true);
    expect(getSessionTargetTerminalMuxReady(store, 'session-2')).toBe(true);

    setSessionTargetTerminalMuxReady(store, 'session-2', false);

    expect(getSessionTargetTerminalMuxReady(store, 'session-1')).toBe(false);
    expect(getSessionTargetTerminalMuxReady(store, 'session-2')).toBe(false);
  });
});
