import { describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createConnectionManager, V1TraversalTransport } from "../../src/index";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";

// Real V1 daemon black-box evidence. Skipped unless explicitly pointed at a
// live daemon. It proves the module talks to the actual product daemon, not a
// local loopback fixture.
const ENABLED = process.env.ZTERM_REAL_DAEMON === "1";
const HOST = process.env.ZTERM_REAL_DAEMON_HOST || "192.168.0.3";
const PORT = Number(process.env.ZTERM_REAL_DAEMON_PORT || "3333");
const TOKEN = process.env.ZTERM_REAL_DAEMON_TOKEN || "";
const DAEMON = process.env.ZTERM_REAL_DAEMON_ID || "mac-studio";
const MACHINE = process.env.ZTERM_REAL_DAEMON_MACHINE || "machine-lan-real";

function authFor(): AuthorizedMachineLink {
  return {
    machineId: MACHINE,
    daemonHostId: DAEMON,
    accountId: "account-real",
    authorizationId: "auth-real",
    capabilities: { channelKinds: ["terminal"], transportKind: "ws" },
    target: {
      bridgeHost: HOST,
      bridgePort: PORT,
      authToken: TOKEN,
      daemonHostId: DAEMON,
      relayHostId: DAEMON,
      relayEndpointCandidates: [],
      transportMode: "websocket",
    },
    settings: { transportMode: "websocket" },
  };
}

/** Read-only real list-sessions to obtain an existing terminal stable identity. */
function fetchFirstStableTerminal(): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { perMessageDeflate: false });
    const finish = (value?: string) => { try { ws.close(); } catch {} resolve(value); };
    const timer = setTimeout(() => finish(undefined), 8000);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "mux-hello", payload: { version: 1, clientInstanceId: "real-stable-fetch", deviceId: "probe" } }));
    });
    ws.on("message", (data) => {
      let frame: unknown;
      try { frame = JSON.parse(typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8")); } catch { return; }
      const m = frame as { type?: string; payload?: unknown };
      if (m.type === "mux-ready") {
        ws.send(JSON.stringify({ type: "mux-target-message", payload: { requestId: "real-ls", message: { type: "list-sessions", payload: { terminalBackend: "tmux" } } } }));
        return;
      }
      if (m.type === "mux-target-message") {
        const payload = m.payload as { message?: { type?: string; payload?: { sessionCatalog?: Array<{ name: string; stableId?: string }> } } };
        if (payload.message?.type === "sessions") {
          const first = (payload.message.payload?.sessionCatalog || []).find((s) => s.stableId);
          clearTimeout(timer);
          finish(first?.stableId);
        }
      }
    });
    ws.on("error", () => { clearTimeout(timer); finish(undefined); });
    ws.on("close", () => { clearTimeout(timer); finish(undefined); });
    setTimeout(() => reject(new Error("stable identity fetch timed out")), 10000);
  });
}

describe.skipIf(!ENABLED)("connections real V1 daemon (read-only handshake + open/ack)", () => {
  it("connects to the real daemon and advertises only the terminal channel capability", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor() },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const obs = manager.observeLink(link);
    expect(obs.status).toBe("connected");
    expect(obs.path).toBe("direct");
    expect(obs.peerIdentity).toBeNull();
    expect(obs.peerIdentityVerified).toBe(false);
    // channelEnvelope is a terminal capability, never a generic message/file.
    expect(obs.capabilities.channelKinds).toEqual(["terminal"]);
    // Generic business channels are explicitly unsupported on this service.
    for (const kind of ["message", "file", "receipt", "status"] as const) {
      await expect(manager.openChannel(link, kind)).rejects.toMatchObject({ code: "unsupported_channel" });
    }
    manager.closeOwnLink(link);
  });

  it("opens an existing terminal channel through real mux open/ack and closes it", async () => {
    const stableId = await fetchFirstStableTerminal();
    // A live production daemon always has at least one existing tmux session.
    expect(stableId).toBeTruthy();
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor() },
      transport: new V1TraversalTransport(),
    });
    const link = await manager.connect(MACHINE);
    const sessionName = "existing-session";
    const channel = await manager.openChannel(link, "terminal", {
      sessionName,
      backend: "tmux",
      expectedSessionIdentity: stableId!,
      existingOnly: true,
      bodySubscribed: false,
    });
    expect(channel.kind).toBe("terminal");
    expect(channel.sessionName).toBeTruthy();
    // Remote ack happened before the channel became addressable; close is local
    // isolation and the link stays connected.
    manager.closeChannel(channel);
    expect(manager.observeLink(link).status).toBe("connected");
    manager.closeOwnLink(link);
  });

  it("rejects the real daemon when the token is wrong", async () => {
    const manager = createConnectionManager({
      authorizationPort: { authorizeMachine: async () => authFor() },
      transport: new V1TraversalTransport(),
    });
    const bad = { ...authFor(), target: { ...authFor().target, authToken: "wrong-token" } };
    await expect(manager.connect(MACHINE, bad)).rejects.toMatchObject({ code: "unauthorized" });
  });
});
