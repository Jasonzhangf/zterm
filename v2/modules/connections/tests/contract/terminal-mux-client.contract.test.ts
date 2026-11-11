import { describe, expect, it } from "vitest";
import { createConnectionManager } from "../support/caller-bound-manager";
import { createTerminalMuxClient } from "../../src/public/terminal-mux-client";
import { ConnectionError } from "../../src/public/errors";
import type {
  ChannelOpenRequest,
  LinkPath,
  SessionCatalogEntry,
} from "../../src/public/types";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";
import type {
  TransportCloseInfo,
  TransportHandle,
} from "../../src/ports/transport";

function authFor(machineId: string, daemonHostId = `daemon-${machineId}`): AuthorizedMachineLink {
  return {
    machineId,
    daemonHostId,
    accountId: "account-1",
    authorizationId: "auth-1",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: "127.0.0.1",
      bridgePort: 47001,
      daemonHostId,
      relayHostId: daemonHostId,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

interface OpenWaiter {
  resolve: (result: { sessionName?: string }) => void;
  reject: (error: unknown) => void;
}

function fakeTransport(options: {
  path?: LinkPath;
  catalog?: readonly SessionCatalogEntry[];
  deferredOpen?: boolean;
  failAfterWrite?: boolean;
} = {}) {
  const state = {
    sent: [] as Array<{ channelId: string; data: string | ArrayBuffer }>,
    opened: [] as ChannelOpenRequest[],
    closed: [] as string[],
    catalogRequests: 0,
    listSessionsError: null as Error | null,
    openError: null as Error | null,
    pendingOpens: new Map<string, OpenWaiter>(),
  };
  const messageHandlers = new Set<(channelId: string, data: string | ArrayBuffer) => void>();
  const channelCloseHandlers = new Set<(channelId: string, info?: { reason?: string; code?: string }) => void>();
  const closeHandlers = new Set<(info: TransportCloseInfo) => void>();
  const catalog = options.catalog ?? [{ name: "session-1", backend: "tmux", stableId: "stable-1" }];

  const handle: TransportHandle = {
    path: options.path ?? "direct",
    transportKind: "ws-direct",
    peerIdentity: "daemon-machine-a",
    peerIdentityVerified: true,
    peerChannelKinds: ["terminal"],
    bufferedBytes: 0,
    listSessions: async () => {
      state.catalogRequests += 1;
      if (state.listSessionsError) throw state.listSessionsError;
      return catalog;
    },
    openChannel: (request) => {
      state.opened.push(request);
      if (state.openError) return Promise.reject(state.openError);
      if (options.deferredOpen) {
        return new Promise<{ sessionName?: string }>((resolve, reject) => {
          state.pendingOpens.set(request.channelId, { resolve, reject });
        });
      }
      return Promise.resolve({ sessionName: request.target?.sessionName });
    },
    sendChannel: (channelId, data) => {
      state.sent.push({ channelId, data });
      if (options.failAfterWrite) {
        throw new ConnectionError("link_closed", "write outcome unknown");
      }
    },
    closeChannel: (channelId) => {
      state.closed.push(channelId);
    },
    close: (code, reason) => {
      for (const handler of [...closeHandlers]) handler({ code, reason });
    },
    onChannelMessage: (handler) => {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onClose: (handler) => {
      closeHandlers.add(handler);
    },
    onChannelClosed: (handler) => {
      channelCloseHandlers.add(handler);
      return () => channelCloseHandlers.delete(handler);
    },
    onChannelCloseFailure: () => () => undefined,
    retryLateOpenClose: () => undefined,
  };

  return {
    handle,
    state,
    resolveOpen(channelId: string, result: { sessionName?: string } = {}) {
      const waiter = state.pendingOpens.get(channelId);
      if (!waiter) throw new Error(`unknown pending open ${channelId}`);
      state.pendingOpens.delete(channelId);
      waiter.resolve(result);
    },
    emitMessage(channelId: string, data: string | ArrayBuffer) {
      for (const handler of [...messageHandlers]) handler(channelId, data);
    },
    emitChannelClosed(channelId: string, info?: { reason?: string; code?: string }) {
      for (const handler of [...channelCloseHandlers]) handler(channelId, info);
    },
    emitLinkClose(info: TransportCloseInfo) {
      for (const handler of [...closeHandlers]) handler(info);
    },
  };
}

function managerFor(fake: ReturnType<typeof fakeTransport>) {
  return createConnectionManager({
    authorizationPort: {
      authorizeMachine: async () => {
        throw new ConnectionError("unauthorized", "no injected authorization");
      },
    },
    transport: { open: async () => fake.handle },
  });
}

function openInput(sessionName: string, stableId: string) {
  return {
    sessionName,
    backend: "tmux" as const,
    stableId,
    bodySubscribed: true,
    widthMode: "mirror-fixed" as const,
    waitMode: "persistent" as const,
  };
}

describe("connections terminal mux client adapter", () => {
  it("reads the catalog through the bound link and maps it to the terminal mux response", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });

    await client.connect();
    const result = await client.requestTarget({
      type: "list-sessions",
      payload: { terminalBackend: "tmux" },
    });

    expect(result.message.payload).toEqual({
      terminalBackend: "tmux",
      sessions: ["session-1"],
      sessionCatalog: [{ name: "session-1", backend: "tmux", stableId: "stable-1" }],
    });
    expect(fake.state.catalogRequests).toBe(1);
    expect(fake.state.opened).toEqual([]);
  });

  it("preserves a malformed catalog failure from the manager", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });
    fake.state.listSessionsError = new ConnectionError("invalid_response", "catalog response is malformed");

    await expect(client.requestTarget({
      type: "list-sessions",
      payload: { terminalBackend: "tmux" },
    })).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("opens exactly the requested terminal target and sends input through that channel", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });

    const opening = client.openChannel(openInput("session-9", "stable-9"));
    expect(opening.channelId).toBeTruthy();
    const channel = await opening;

    expect(fake.state.opened[0]?.kind).toBe("terminal");
    expect(fake.state.opened[0]?.target).toMatchObject({
      sessionName: "session-9",
      backend: "tmux",
      expectedSessionIdentity: "stable-9",
      existingOnly: true,
      bodySubscribed: true,
    });
    client.sendChannelMessage(channel.channelId, { type: "input", payload: "printf hello\r" });
    expect(fake.state.sent).toEqual([
      {
        channelId: fake.state.opened[0]?.channelId,
        data: JSON.stringify({ type: "input", payload: "printf hello\r" }),
      },
    ]);
  });

  it("routes decoded channel messages only to the subscribed channel", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });
    const first = await client.openChannel(openInput("first", "stable-first"));
    const second = await client.openChannel(openInput("second", "stable-second"));
    const firstMessages: unknown[] = [];
    const secondMessages: unknown[] = [];
    client.subscribeChannel(first.channelId, (message) => firstMessages.push(message));
    client.subscribeChannel(second.channelId, (message) => secondMessages.push(message));

    const payload = { type: "buffer-head", payload: { revision: 1 } };
    fake.emitMessage(fake.state.opened[0]!.channelId, JSON.stringify(payload));

    expect(firstMessages).toEqual([payload]);
    expect(secondMessages).toEqual([]);
  });

  it("rejects a failed channel open without publishing a channel", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });
    fake.state.openError = new ConnectionError("link_closed", "remote rejected the target");

    await expect(client.openChannel(openInput("missing", "stable-missing")))
      .rejects.toMatchObject({ code: "link_closed" });
    expect(fake.state.closed).toEqual([]);
  });

  it("cancels a pending open and releases a late accepted channel", async () => {
    const fake = fakeTransport({ deferredOpen: true });
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });

    const opening = client.openChannel(openInput("session-9", "stable-9"));
    expect(client.cancelOpenChannel(opening.channelId)).toBe(true);
    await expect(opening).rejects.toMatchObject({ code: "V1_CHANNEL_OPEN_CANCELLED" });

    const actual = fake.state.opened[0]?.channelId;
    expect(actual).toBeTruthy();
    fake.resolveOpen(actual!, { sessionName: "session-9" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.state.closed).toContain(actual);
  });

  it("keeps a stale adapter from opening on a newer generation", async () => {
    const first = fakeTransport();
    const second = fakeTransport();
    const handles = [first.handle, second.handle];
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => handles.shift()! },
    });

    const staleLink = await manager.connect("machine-a");
    const staleClient = createTerminalMuxClient({ connectionManager: manager, link: staleLink });
    const currentLink = await manager.connect("machine-a", authFor("machine-a"));
    const currentClient = createTerminalMuxClient({ connectionManager: manager, link: currentLink });
    const currentCloseEvents: unknown[] = [];
    currentClient.onClose((error) => currentCloseEvents.push(error));

    await expect(staleClient.openChannel(openInput("stale", "stable-stale")))
      .rejects.toMatchObject({ code: "stale_generation" });
    first.emitLinkClose({ code: 1006, reason: "stale socket closed" });
    expect(currentCloseEvents).toEqual([]);
    expect(manager.observeLink(currentLink).status).toBe("connected");
  });

  it("projects a physical link close as a terminal transport close without reopening", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });
    const events: Array<{ code?: string }> = [];
    client.onClose((error) => events.push(error as { code?: string }));

    fake.emitLinkClose({ code: 1006, reason: "network lost" });

    expect(events).toHaveLength(1);
    expect(events[0]?.code).toBe("TRANSPORT_CLOSED");
    await expect(client.connect()).rejects.toMatchObject({ code: "TRANSPORT_CLOSED" });
    expect(manager.observeLink(link).status).toBe("closed");
  });

  it("isolates one remote channel close from a sibling channel", async () => {
    const fake = fakeTransport();
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });
    const first = await client.openChannel(openInput("first", "stable-first"));
    const second = await client.openChannel(openInput("second", "stable-second"));
    const firstEvents: unknown[] = [];
    const secondEvents: unknown[] = [];
    client.subscribeChannel(first.channelId, (message) => firstEvents.push(message));
    client.subscribeChannel(second.channelId, (message) => secondEvents.push(message));

    const firstActual = fake.state.opened[0]?.channelId;
    const secondActual = fake.state.opened[1]?.channelId;
    expect(firstActual).toBeTruthy();
    expect(secondActual).toBeTruthy();
    fake.emitChannelClosed(firstActual!, { reason: "session ended", code: "remote_closed" });

    expect(firstEvents).toEqual([{
      type: "mux-channel-closed",
      payload: { channelId: first.channelId, reason: "session ended", code: "remote_closed" },
    }]);
    expect(secondEvents).toEqual([]);
    expect(() => client.sendChannelMessage(first.channelId, { type: "input", payload: "closed" }))
      .toThrow(expect.objectContaining({ code: "V1_CHANNEL_CLOSED" }));
    client.sendChannelMessage(second.channelId, { type: "input", payload: "still-live" });
    expect(fake.state.sent.at(-1)?.channelId).toBe(secondActual);
    expect(manager.observeLink(link).status).toBe("connected");
  });

  it("does not replay input when the write outcome is unknown", async () => {
    const fake = fakeTransport({ failAfterWrite: true });
    const manager = managerFor(fake);
    const link = await manager.connect("machine-a", authFor("machine-a"));
    const client = createTerminalMuxClient({ connectionManager: manager, link });
    const channel = await client.openChannel(openInput("session-9", "stable-9"));

    expect(() => client.sendChannelMessage(channel.channelId, { type: "input", payload: "once\r" }))
      .toThrow(expect.objectContaining({ code: "link_closed" }));
    expect(fake.state.sent).toHaveLength(1);
    expect(fake.state.sent[0]?.data).toBe(JSON.stringify({ type: "input", payload: "once\r" }));
  });
});
