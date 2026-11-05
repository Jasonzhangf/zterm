import { describe, expect, it } from "vitest";
import { createConnectionManager } from "../../src/index";
import { ConnectionError } from "../../src/public/errors";
import type {
  ChannelMessage,
  ChannelOpenRequest,
  LinkKind,
  LinkPath,
} from "../../src/public/types";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";
import type { TransportHandle, TransportPort } from "../../src/ports/transport";

function authFor(machineId: string, daemonHostId = `daemon-${machineId}`): AuthorizedMachineLink {
  return {
    machineId,
    daemonHostId,
    accountId: "account-1",
    authorizationId: "auth-1",
    capabilities: { channelKinds: ["terminal", "message", "file", "receipt", "status"], transportKind: "ws" },
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

interface FakeTransport {
  handle: TransportHandle;
  feedChannel(data: string | ArrayBuffer, channelId: string): void;
  sent: Array<{ channelId: string; data: string | ArrayBuffer }>;
  opened: ChannelOpenRequest[];
  closed: string[];
  emittedClose: { code?: number; reason?: string } | null;
  emitChannelClosed(channelId: string): void;
}

function fakeTransport(path: LinkPath, peerIdentity: string, channelKinds: LinkKind[]): FakeTransport {
  const handlers = new Set<(channelId: string, data: string | ArrayBuffer) => void>();
  const channelCloseHandlers = new Set<(channelId: string, info?: { reason?: string; code?: string }) => void>();
  let closeHandler: ((i: { code?: number; reason?: string }) => void) | null = null;
  const state = {
    emittedClose: null as { code?: number; reason?: string } | null,
    sent: [] as Array<{ channelId: string; data: string | ArrayBuffer }>,
    opened: [] as ChannelOpenRequest[],
    closed: [] as string[],
  };
  const handle: TransportHandle = {
    path,
    transportKind: `ws-${path}`,
    peerIdentity,
    peerIdentityVerified: peerIdentity.length > 0,
    peerChannelKinds: channelKinds,
    bufferedBytes: 0,
    openChannel: async (request) => {
      state.opened.push(request);
      return request.kind === "terminal" ? { sessionName: request.target?.sessionName ?? "session-1" } : {};
    },
    sendChannel: (channelId, data) => { state.sent.push({ channelId, data }); },
    closeChannel: (channelId) => { state.closed.push(channelId); },
    close: (code, reason) => {
      state.emittedClose = { code, reason };
      closeHandler?.({ code, reason });
    },
    onChannelMessage: (handler) => {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    onClose: (handler) => { closeHandler = handler; },
    onChannelClosed: (handler) => {
      channelCloseHandlers.add(handler);
      return () => channelCloseHandlers.delete(handler);
    },
    onChannelCloseFailure: () => () => undefined,
    retryLateOpenClose: () => undefined,
  };
  return {
    handle,
    feedChannel: (data, channelId) => { for (const h of [...handlers]) h(channelId, data); },
    emitChannelClosed: (channelId) => {
      for (const h of [...channelCloseHandlers]) h(channelId, { reason: "remote-closed", code: "remote_closed" });
    },
    get sent() { return state.sent; },
    get opened() { return state.opened; },
    get closed() { return state.closed; },
    get emittedClose() { return state.emittedClose; },
  };
}

describe("connections contract", () => {
  it("connects with a verified authorization and records the real path + peer identity", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => { throw new Error("must not be called"); } },
      transport: { open: async () => fakeTransport("direct", "daemon-machine-a", ["terminal", "status"]).handle },
    });
    const link = await manager.connect("machine-a", authFor("machine-a"));
    expect(link.machineId).toBe("machine-a");
    expect(link.generation).toBe(1);
    const obs = manager.observeLink(link);
    expect(obs.status).toBe("connected");
    expect(obs.path).toBe("direct");
    expect(obs.freshness).toBe("fresh");
    expect(obs.peerIdentity).toBe("daemon-machine-a");
    expect(obs.capabilities.channelKinds).toEqual(["terminal", "status"]);
  });

  it("records the relay path truthfully when the transport proves relay", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("relay", "daemon-machine-a", ["terminal"]).handle },
    });
    const link = await manager.connect("machine-a");
    expect(manager.observeLink(link).path).toBe("relay");
  });

  it("rejects empty machineId as invalid input", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("direct", "daemon-machine-a", ["terminal"]).handle },
    });
    await expect(manager.connect("   ", authFor("machine-a"))).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects an authorization for a different machine without opening", async () => {
    let opened = false;
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => { opened = true; return fakeTransport("direct", "x", ["terminal"]).handle; } },
    });
    await expect(manager.connect("machine-b")).rejects.toMatchObject({ code: "machine_mismatch" });
    expect(opened).toBe(false);
  });

  it("does not bypass a directory rejection through another channel", async () => {
    const manager = createConnectionManager({
      authorizationPort: {
        authorizeMachine: async () => {
          throw new ConnectionError("directory_rejected", "machine not authorized", { machineId: "machine-a" });
        },
      },
      transport: { open: async () => fakeTransport("direct", "x", ["terminal"]).handle },
    });
    await expect(manager.connect("machine-a")).rejects.toMatchObject({ code: "directory_rejected" });
  });

  it("surfaces unauthorized without fallback", async () => {
    const manager = createConnectionManager({
      authorizationPort: {
        authorizeMachine: async () => {
          throw new ConnectionError("unauthorized", "grant expired", { machineId: "machine-a" });
        },
      },
      transport: { open: async () => fakeTransport("direct", "x", ["terminal"]).handle },
    });
    await expect(manager.connect("machine-a")).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not report an unreachable endpoint as connected", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => { throw new ConnectionError("unreachable", "connection refused", { machineId: "machine-a" }); } },
    });
    await expect(manager.connect("machine-a")).rejects.toMatchObject({ code: "unreachable" });
  });

  it("rejects an unsupported channel kind explicitly", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("direct", "daemon-machine-a", ["terminal"]).handle },
    });
    const link = await manager.connect("machine-a");
    await expect(manager.openChannel(link, "file")).rejects.toMatchObject({ code: "unsupported_channel" });
    // The link and its supported channel stay usable after the rejection.
    expect(manager.observeLink(link).status).toBe("connected");
    expect((await manager.openChannel(link, "terminal", { sessionName: "s1" })).kind).toBe("terminal");
  });

  it("opens a terminal channel only after the peer accepts the real target", async () => {
    const fake = fakeTransport("direct", "daemon-machine-a", ["terminal"]);
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fake.handle },
    });
    const link = await manager.connect("machine-a");
    const channel = await manager.openChannel(link, "terminal", {
      sessionName: "session-9",
      backend: "tmux",
      expectedSessionIdentity: "stable-9",
    });
    expect(channel.sessionName).toBe("session-9");
    expect(fake.opened).toHaveLength(1);
    expect(fake.opened[0].kind).toBe("terminal");
    expect(fake.opened[0].target?.sessionName).toBe("session-9");
  });

  it("rejects a terminal open with no target sessionName", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("direct", "daemon-machine-a", ["terminal"]).handle },
    });
    const link = await manager.connect("machine-a");
    await expect(manager.openChannel(link, "terminal")).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("isolates channels: closing one channel does not close a sibling or the link", async () => {
    const fake = fakeTransport("direct", "daemon-machine-a", ["message", "status"]);
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fake.handle },
    });
    const link = await manager.connect("machine-a");
    const message = await manager.openChannel(link, "message");
    const status = await manager.openChannel(link, "status");
    // Frame addressed to `message` does not reach `status`, and vice versa.
    const messageReceived: ChannelMessage[] = [];
    const statusReceived: ChannelMessage[] = [];
    manager.onChannelMessage(message, (m) => messageReceived.push(m));
    manager.onChannelMessage(status, (m) => statusReceived.push(m));
    fake.feedChannel("hello-message", message.id);
    fake.feedChannel("hello-status", status.id);
    expect(messageReceived).toHaveLength(1);
    expect(messageReceived[0].data).toBe("hello-message");
    expect(statusReceived).toHaveLength(1);
    expect(statusReceived[0].data).toBe("hello-status");
    // A frame addressed to an address that was never opened reaches nobody.
    fake.feedChannel("orphan", `${link.id}#message#unopened`);
    expect(messageReceived).toHaveLength(1);
    expect(statusReceived).toHaveLength(1);
    // send writes a legal addressed envelope, not a bare broadcast.
    manager.sendChannel(message, "outbound");
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0].channelId).toBe(message.id);
    expect(fake.sent[0].data).toBe("outbound");
    manager.closeChannel(message);
    expect(fake.closed).toContain(message.id);
    expect(manager.observeLink(link).status).toBe("connected");
    expect(status.kind).toBe("status");
  });

  it("fences a stale generation so an old socket cannot overwrite the new link", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("direct", "daemon-machine-a", ["terminal"]).handle },
    });
    const link = await manager.connect("machine-a");
    try {
      manager.observeLink({ ...link, generation: 0 });
      throw new Error("expected stale_generation");
    } catch (error) {
      expect((error as ConnectionError).code).toBe("stale_generation");
    }
    expect(manager.observeLink(link).status).toBe("connected");
  });

  it("closes the own link and reports a stale (not fresh) observation", async () => {
    const fake = fakeTransport("direct", "daemon-machine-a", ["terminal"]);
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fake.handle },
    });
    const link = await manager.connect("machine-a");
    manager.closeOwnLink(link);
    const obs = manager.observeLink(link);
    expect(obs.status).toBe("closed");
    expect(obs.freshness).toBe("stale");
    expect(fake.emittedClose?.code).toBe(1000);
  });

  it("rejects operations on an unknown link", () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("direct", "x", ["terminal"]).handle },
    });
    try {
      manager.observeLink({ id: "link:none", machineId: "none", generation: 1 });
      throw new Error("expected link_not_found");
    } catch (error) {
      expect((error as ConnectionError).code).toBe("link_not_found");
    }
  });

  it("fences a late close callback from a superseded socket", async () => {
    const opened: FakeTransport[] = [];
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: {
        open: async () => {
          const fake = fakeTransport("direct", "daemon-machine-a", ["terminal"]);
          opened.push(fake);
          return fake.handle;
        },
      },
    });
    const first = await manager.connect("machine-a", authFor("machine-a"));
    const second = await manager.connect("machine-a", authFor("machine-a"));
    expect(first.generation).toBe(1);
    expect(second.generation).toBe(2);
    // A late close/error frame from the old socket must not overwrite the new link.
    opened[0].handle.close(4001, "late-stale-callback");
    const obs = manager.observeLink(second);
    expect(obs.status).toBe("connected");
    expect(obs.generation).toBe(2);
  });

  it("projects live transport backpressure instead of the connect-time snapshot", async () => {
    let buffered = 0;
    const handle: TransportHandle = {
      path: "direct",
      transportKind: "ws-direct",
      peerIdentity: "daemon-machine-a",
      peerIdentityVerified: true,
      peerChannelKinds: ["terminal"],
      get bufferedBytes() { return buffered; },
      openChannel: async () => ({}),
      sendChannel: () => undefined,
      closeChannel: () => undefined,
      close: () => undefined,
      onChannelMessage: () => () => undefined,
      onClose: () => undefined,
      onChannelClosed: () => () => undefined,
      onChannelCloseFailure: () => () => undefined,
      retryLateOpenClose: () => undefined,
    };
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => handle },
    });
    const link = await manager.connect("machine-a", authFor("machine-a"));
    expect(manager.observeLink(link).backpressure).toEqual({
      queuedBytes: 0,
      bufferedBytes: 0,
      backpressured: false,
    });
    buffered = 12;
    expect(manager.observeLink(link).backpressure).toEqual({
      queuedBytes: 0,
      bufferedBytes: 12,
      backpressured: true,
    });
  });

  it("rejects every channel kind when the transport negotiated none", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fakeTransport("direct", "daemon-machine-a", []).handle },
    });
    const link = await manager.connect("machine-a");
    expect(manager.observeLink(link).capabilities.channelKinds).toEqual([]);
    for (const kind of ["terminal", "message", "file", "receipt", "status"] as LinkKind[]) {
      await expect(manager.openChannel(link, kind)).rejects.toMatchObject({ code: "unsupported_channel" });
    }
    // Explicit rejection is isolated from the link: it stays connected.
    expect(manager.observeLink(link).status).toBe("connected");
  });

  it("does not let a failing older generation overwrite a newer connected link", async () => {
    let calls = 0;
    let rejectFirst!: (error: unknown) => void;
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: {
        open: async () => {
          calls += 1;
          if (calls === 1) {
            return await new Promise<TransportHandle>((_resolve, reject) => {
              rejectFirst = reject;
            });
          }
          return fakeTransport("direct", "daemon-machine-a", ["terminal"]).handle;
        },
      },
    });
    const first = manager.connect("machine-a", authFor("machine-a"));
    const second = await manager.connect("machine-a", authFor("machine-a"));
    expect(second.generation).toBe(2);
    expect(manager.observeLink(second).status).toBe("connected");
    // The older pending attempt now fails late: it must not flip the new link.
    rejectFirst(new ConnectionError("unreachable", "first attempt failed late", { machineId: "machine-a" }));
    await expect(first).rejects.toMatchObject({ code: "unreachable" });
    const observation = manager.observeLink(second);
    expect(observation.generation).toBe(2);
    expect(observation.status).toBe("connected");
    expect(observation.errorCode).toBeUndefined();
  });

  it("invalidates a remotely closed channel while keeping its sibling and link usable", async () => {
    const fake = fakeTransport("direct", "daemon-machine-a", ["message", "status"]);
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fake.handle },
    });
    const link = await manager.connect("machine-a");
    const first = await manager.openChannel(link, "message");
    const sibling = await manager.openChannel(link, "status");
    const siblingMessages: string[] = [];
    manager.onChannelMessage(sibling, (message) => siblingMessages.push(String(message.data)));

    fake.emitChannelClosed(first.id);

    expect(() => manager.sendChannel(first, "stale")).toThrow(expect.objectContaining({ code: "link_closed" }));
    expect(() => manager.closeChannel(first)).toThrow(expect.objectContaining({ code: "link_closed" }));
    manager.sendChannel(sibling, "sibling-live");
    fake.feedChannel("sibling-inbound", sibling.id);
    expect(siblingMessages).toEqual(["sibling-inbound"]);
    expect(fake.sent.at(-1)?.channelId).toBe(sibling.id);
    expect(manager.observeLink(link).status).toBe("connected");
  });

  it("keeps a channel recoverable when its close frame cannot be sent", async () => {
    const fake = fakeTransport("direct", "daemon-machine-a", ["message"]);
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fake.handle },
    });
    const link = await manager.connect("machine-a");
    const channel = await manager.openChannel(link, "message");
    const originalClose = fake.handle.closeChannel;
    fake.handle.closeChannel = () => { throw new Error("socket write failed"); };

    let failure: unknown;
    try {
      manager.closeChannel(channel);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(ConnectionError);
    expect((failure as ConnectionError).code).toBe("link_closed");
    expect(((failure as Error).cause as Error).message).toBe("socket write failed");

    const recovered: string[] = [];
    manager.onChannelMessage(channel, (message) => recovered.push(String(message.data)));
    manager.sendChannel(channel, "still-open");
    fake.feedChannel("inbound", channel.id);
    expect(recovered).toEqual(["inbound"]);
    expect(fake.sent.at(-1)?.channelId).toBe(channel.id);

    fake.handle.closeChannel = originalClose;
    manager.closeChannel(channel);
    expect(fake.closed).toContain(channel.id);
    expect(() => manager.sendChannel(channel, "after-close")).toThrow(expect.objectContaining({ code: "link_closed" }));
  });

  it("drops channels when the physical transport closes", async () => {
    const fake = fakeTransport("direct", "daemon-machine-a", ["message"]);
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => fake.handle },
    });
    const link = await manager.connect("machine-a");
    const channel = await manager.openChannel(link, "message");

    fake.handle.close(1006, "transport lost");

    expect(manager.observeLink(link).status).toBe("closed");
    expect(() => manager.sendChannel(channel, "after-loss")).toThrow(expect.objectContaining({ code: "link_closed" }));
  });

  it("removes a channel that completes after its link generation was superseded", async () => {
    const firstFake = fakeTransport("direct", "daemon-machine-a", ["terminal"]);
    const secondFake = fakeTransport("direct", "daemon-machine-a", ["terminal"]);
    let resolveOpen!: (result: { sessionName?: string }) => void;
    let staleRequest!: ChannelOpenRequest;
    firstFake.handle.openChannel = (request) => {
      staleRequest = request;
      return new Promise((resolve) => { resolveOpen = resolve; });
    };
    firstFake.handle.closeChannel = () => { throw new Error("old transport is closed"); };
    const handles = [firstFake.handle, secondFake.handle];
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor("machine-a") },
      transport: { open: async () => handles.shift()! },
    });

    const firstLink = await manager.connect("machine-a");
    const opening = manager.openChannel(firstLink, "terminal", { sessionName: "stale-session" });
    expect(staleRequest).toBeDefined();
    const currentLink = await manager.connect("machine-a");
    resolveOpen({ sessionName: "stale-session" });

    await expect(opening).rejects.toMatchObject({ code: "stale_generation" });
    expect(() => manager.sendChannel({
      id: staleRequest.channelId,
      linkId: firstLink.id,
      kind: "terminal",
    }, "zombie")).toThrow(expect.objectContaining({ code: "link_closed" }));
    expect(manager.observeLink(currentLink).status).toBe("connected");
  });
});
