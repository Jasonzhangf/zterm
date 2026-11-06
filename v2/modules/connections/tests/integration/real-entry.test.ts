import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  buildTerminalMuxCapabilities,
  buildTerminalMuxReady,
  isTerminalMuxClientFrame,
} from "@zterm/shared/connection/protocol";
import { createConnectionManager, V1TraversalTransport } from "../../src/index";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";

const TOKEN = "test-token-abc";
const DAEMON = "daemon-lan-peer";
const MACHINE = "machine-lan-peer";
const KNOWN_SESSION = "known-session";

// Modes model the real V1 daemon wire behavior. "ok" sends mux-ready WITHOUT
// daemonHostId, exactly like the live daemon; the identity modes declare a
// matching or different identity. There is no generic message/file capability
// on the terminal mux in any mode.
type ConnectionMode = "ok" | "identity-match" | "identity-mismatch" | "bad-json" | "non-mux" | "mux-error";

let failNextLateOpenClose = false;

class FailOnceLateOpenCloseWebSocket extends WebSocket {
  override send(data: RawData, options?: unknown, callback?: unknown): void {
    if (failNextLateOpenClose && String(data).includes("\"reason\":\"late-open-release\"")) {
      failNextLateOpenClose = false;
      throw new Error("late-open close send failed");
    }
    super.send(data, options as never, callback as never);
  }
}

function authFor(host: string, port: number, token: string, daemon = DAEMON): AuthorizedMachineLink {
  return {
    machineId: MACHINE,
    daemonHostId: daemon,
    accountId: "account-integration",
    authorizationId: "auth-integration",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: host,
      bridgePort: port,
      authToken: token,
      daemonHostId: daemon,
      relayHostId: daemon,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("connections real-entry (LAN direct, real mux wire)", () => {
  let server: Server;
  let wsServer: WebSocketServer;
  let port: number;
  let host: string;
  let nextMode: ConnectionMode = "ok";
  let notifyBadSocketClosed: (() => void) | null = null;
  let holdChannelOpenAcks = false;
  let releaseHeldChannelOpenAck: (() => void) | null = null;
  let remoteCloseAcceptedChannel: ((channelId: string) => void) | null = null;
  let lastClientChannelClose: { channelId: string; reason?: string } | null = null;

  beforeAll(async () => {
    // Bind to the container LAN interface so this is a real network socket,
    // not a same-process shortcut.
    host = process.env.ZTERM_TEST_BIND || "127.0.0.1";
    server = createServer();
    wsServer = new WebSocketServer({ server });
    wsServer.on("connection", (socket, req) => {
      const mode = nextMode;
      const url = new URL(req.url || "/", "http://localhost");
      if (url.searchParams.get("token") !== TOKEN) {
        socket.close(4001, "unauthorized");
        return;
      }
      if (mode === "bad-json" || mode === "non-mux" || mode === "mux-error") {
        socket.on("close", () => notifyBadSocketClosed?.());
      }
      const openChannels = new Set<string>();
      remoteCloseAcceptedChannel = (channelId) => {
        if (!openChannels.has(channelId)) return;
        openChannels.delete(channelId);
        socket.send(JSON.stringify({
          type: "mux-channel-closed",
          payload: { channelId, reason: "remote-closed", code: "remote_closed" },
        }));
      };
      socket.on("message", (raw) => {
        let parsed: unknown;
        try { parsed = JSON.parse(raw.toString()); } catch { return; }
        if (!isTerminalMuxClientFrame(parsed)) return;
        if (parsed.type === "mux-hello") {
          if (mode === "bad-json") {
            socket.send("not-json{");
          } else if (mode === "non-mux") {
            socket.send(JSON.stringify({ type: "app-hello", payload: {} }));
          } else if (mode === "mux-error") {
            socket.send(JSON.stringify({ type: "mux-error", payload: { code: "mux_protocol_invalid", message: "bad handshake" } }));
          } else if (mode === "identity-mismatch") {
            socket.send(JSON.stringify(buildTerminalMuxReady({
              daemonHostId: "some-other-daemon",
              capabilities: buildTerminalMuxCapabilities({ reliableInput: { version: 1 } }),
            })));
          } else if (mode === "identity-match") {
            socket.send(JSON.stringify(buildTerminalMuxReady({
              daemonHostId: DAEMON,
              capabilities: buildTerminalMuxCapabilities({ reliableInput: { version: 1 } }),
            })));
          } else {
            // The live V1 daemon omits daemonHostId and advertises channelEnvelope
            // with no generic message/file declaration.
            socket.send(JSON.stringify(buildTerminalMuxReady({
              capabilities: buildTerminalMuxCapabilities({ reliableInput: { version: 1 } }),
            })));
          }
          return;
        }
        if (mode !== "ok" && mode !== "identity-match") return;
        if (parsed.type === "mux-channel-open") {
          const { channelId, sessionName } = parsed.payload;
          if (sessionName === KNOWN_SESSION) {
            const accept = () => {
              openChannels.add(channelId);
              socket.send(JSON.stringify({
                type: "mux-channel-opened",
                payload: { channelId, sessionName, stableId: `stable-${sessionName}`, capabilities: { reliableInput: { version: 1 } } },
              }));
            };
            if (holdChannelOpenAcks) {
              releaseHeldChannelOpenAck = accept;
            } else {
              accept();
            }
          } else {
            socket.send(JSON.stringify({
              type: "mux-channel-closed",
              payload: { channelId, reason: "session not found", code: "session_identity_mismatch" },
            }));
          }
          return;
        }
        if (parsed.type === "mux-channel-binary" && openChannels.has(parsed.payload.channelId)) {
          // Real terminal output is delivered as an addressed channel frame on
          // the accepted channel id, not a generic echo to every channel.
          socket.send(JSON.stringify({
            type: "mux-channel-message",
            payload: {
              channelId: parsed.payload.channelId,
              message: { type: "session-preview", data: Buffer.from(parsed.payload.dataBase64, "base64").toString("utf8") },
            },
          }));
        }
        if (parsed.type === "mux-channel-close") {
          lastClientChannelClose = {
            channelId: parsed.payload.channelId,
            ...(typeof parsed.payload.reason === "string" ? { reason: parsed.payload.reason } : {}),
          };
          openChannels.delete(parsed.payload.channelId);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("no address");
    port = address.port;
  });

  afterEach(() => {
    nextMode = "ok";
    notifyBadSocketClosed = null;
    holdChannelOpenAcks = false;
    releaseHeldChannelOpenAck = null;
    remoteCloseAcceptedChannel = null;
    lastClientChannelClose = null;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("connects over a real LAN websocket and records direct path with terminal-only capability", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const obs = manager.observeLink(link);
    expect(obs.status).toBe("connected");
    expect(obs.path).toBe("direct");
    // The mux omits daemonHostId on the wire, so no peer identity is observed.
    expect(obs.peerIdentity).toBeNull();
    expect(obs.peerIdentityVerified).toBe(false);
    // channelEnvelope is a terminal channel capability, NOT a message/file service.
    expect(obs.capabilities.channelKinds).toEqual(["terminal"]);
    manager.closeOwnLink(link);
  });

  it("does not advertise or open generic message/file on the terminal mux", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    for (const kind of ["message", "file", "receipt", "status"] as const) {
      await expect(manager.openChannel(link, kind)).rejects.toMatchObject({ code: "unsupported_channel" });
    }
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeOwnLink(link);
  });

  it("opens a real terminal channel only after the daemon accepts the target", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const channel = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION, backend: "tmux" });
    expect(channel.kind).toBe("terminal");
    expect(channel.sessionName).toBe(KNOWN_SESSION);
    manager.closeChannel(channel);
    manager.closeOwnLink(link);
  });

  it("rejects a terminal open when the daemon refuses the target", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    await expect(manager.openChannel(link, "terminal", { sessionName: "missing-session" })).rejects.toMatchObject({
      code: "link_closed",
    });
    // The refusal is isolated: the link stays connected.
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeOwnLink(link);
  });

  it("isolates two accepted terminal channels by address", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const first = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    const second = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    expect(first.id).not.toBe(second.id);

    const firstSeen: string[] = [];
    const secondSeen: string[] = [];
    manager.onChannelMessage(first, (message) => firstSeen.push(String(message.data)));
    manager.onChannelMessage(second, (message) => secondSeen.push(String(message.data)));

    manager.sendChannel(first, "payload-one");
    await waitFor(() => firstSeen.length > 0);
    expect(firstSeen[0]).toContain("payload-one");
    expect(secondSeen).toHaveLength(0);

    manager.closeChannel(first);
    manager.sendChannel(second, "payload-two");
    await waitFor(() => secondSeen.length > 0);
    expect(secondSeen[0]).toContain("payload-two");
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeOwnLink(link);
  });

  it("releases a socket after a bad handshake and leaves another link usable", async () => {
    nextMode = "ok";
    const healthy = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const healthyLink = await healthy.connect(MACHINE);
    expect(healthy.observeLink(healthyLink).status).toBe("connected");

    for (const mode of ["bad-json", "non-mux", "mux-error"] as const) {
      nextMode = mode;
      const badSocketClosed = new Promise<void>((resolve) => { notifyBadSocketClosed = resolve; });
      const bad = createConnectionManager({
        authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
        transport: new V1TraversalTransport(),
      });
      await expect(bad.connect(MACHINE)).rejects.toMatchObject({ code: "unknown" });
      await badSocketClosed;
      notifyBadSocketClosed = null;
      expect(healthy.observeLink(healthyLink).status).toBe("connected");
    }
    healthy.closeOwnLink(healthyLink);
  });

  it("rejects a wrong token as unauthorized without reporting connected", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, "wrong-token") },
      transport: new V1TraversalTransport(),
    });
    await expect(manager.connect(MACHINE)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("does not report an unreachable port as connected", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, 1, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    await expect(manager.connect(MACHINE)).rejects.toMatchObject({ code: "unreachable" });
  });

  it("accepts a matching declared peer identity as verified", async () => {
    nextMode = "identity-match";
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const obs = manager.observeLink(link);
    expect(obs.peerIdentity).toBe(DAEMON);
    expect(obs.peerIdentityVerified).toBe(true);
    manager.closeOwnLink(link);
  });

  it("does not project the expected identity when mux-ready omits it", async () => {
    const expected = "expected-only";
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN, expected) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const obs = manager.observeLink(link);
    expect(obs.peerIdentity).toBeNull();
    expect(obs.peerIdentityVerified).toBe(false);
    manager.closeOwnLink(link);
  });

  it("rejects a declared peer identity mismatch and never reports connected", async () => {
    nextMode = "identity-mismatch";
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN, "expected-daemon") },
      transport: new V1TraversalTransport(),
    });
    await expect(manager.connect(MACHINE)).rejects.toMatchObject({ code: "peer_identity_mismatch" });
  });

  it("releases a channel accepted after its local open timed out and keeps the link usable", async () => {
    holdChannelOpenAcks = true;
    lastClientChannelClose = null;
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const opening = manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    await waitFor(() => releaseHeldChannelOpenAck !== null);

    await expect(opening).rejects.toMatchObject({ code: "unreachable" });
    holdChannelOpenAcks = false;
    releaseHeldChannelOpenAck!();
    releaseHeldChannelOpenAck = null;
    await waitFor(() => lastClientChannelClose?.reason === "late-open-release");

    const next = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    const seen: string[] = [];
    manager.onChannelMessage(next, (message) => seen.push(String(message.data)));
    manager.sendChannel(next, "after-late-release");
    await waitFor(() => seen.length > 0);
    expect(seen[0]).toContain("after-late-release");
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeChannel(next);
    manager.closeOwnLink(link);
  }, 15000);

  it("retains a late-open release after a close send failure and retries only that channel", async () => {
    const machine = "machine-late-open-retry";
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => ({ ...authFor(host, port, TOKEN), machineId: machine }) },
      transport: new V1TraversalTransport({ WebSocket: FailOnceLateOpenCloseWebSocket }),
    });
    const link = await manager.connect(machine);
    const sibling = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });

    holdChannelOpenAcks = true;
    const opening = manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    await waitFor(() => releaseHeldChannelOpenAck !== null);
    await expect(opening).rejects.toMatchObject({ code: "unreachable" });

    const failureSeen = new Promise<Error & { code?: string; channelId?: string; cause?: unknown }>((resolve) => {
      manager.onChannelCloseFailure(link, resolve);
    });
    holdChannelOpenAcks = false;
    failNextLateOpenClose = true;
    releaseHeldChannelOpenAck!();
    releaseHeldChannelOpenAck = null;

    const failure = await failureSeen;
    expect(failure).toMatchObject({ code: "channel_close_failed" });
    expect(failure.channelId).toBeTruthy();
    expect((failure.cause as Error).message).toContain("late-open close send failed");
    expect(lastClientChannelClose?.channelId).not.toBe(failure.channelId);

    manager.retryLateOpenClose(link, failure.channelId!);
    await waitFor(() => lastClientChannelClose?.channelId === failure.channelId);
    expect(lastClientChannelClose).toMatchObject({
      channelId: failure.channelId,
      reason: "late-open-release",
    });

    const seen: string[] = [];
    manager.onChannelMessage(sibling, (message) => seen.push(String(message.data)));
    manager.sendChannel(sibling, "sibling-after-retry");
    await waitFor(() => seen.length > 0);
    expect(seen[0]).toContain("sibling-after-retry");
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeChannel(sibling);
    manager.closeOwnLink(link);
  }, 30000);

  it("invalidates a remotely closed channel without disturbing its sibling", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor(host, port, TOKEN) },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const first = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    const sibling = await manager.openChannel(link, "terminal", { sessionName: KNOWN_SESSION });
    expect(remoteCloseAcceptedChannel).not.toBeNull();

    remoteCloseAcceptedChannel!(first.id);
    await waitFor(() => {
      try {
        manager.sendChannel(first, "probe");
        return false;
      } catch {
        return true;
      }
    });
    expect(() => manager.sendChannel(first, "stale")).toThrow(expect.objectContaining({ code: "link_closed" }));
    expect(() => manager.closeChannel(first)).toThrow(expect.objectContaining({ code: "link_closed" }));

    const seen: string[] = [];
    manager.onChannelMessage(sibling, (message) => seen.push(String(message.data)));
    manager.sendChannel(sibling, "sibling-live");
    await waitFor(() => seen.length > 0);
    expect(seen[0]).toContain("sibling-live");
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeChannel(sibling);
    manager.closeOwnLink(link);
  });
});
