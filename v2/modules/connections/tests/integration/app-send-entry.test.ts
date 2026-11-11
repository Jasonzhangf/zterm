import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  APP_PROTOCOL_VERSION,
  type AppClientFrame,
  type AppServerFrame,
} from "@zterm/shared/connection/app-protocol";
import { createConnectionManager } from "../support/caller-bound-manager";
import { AppWebSocketTransport } from "../../src/adapters/app-websocket";
import type { AuthorizedMachineLink } from "../../src/ports/accounts-authorization";

const TOKEN = "test-source-token";
const SOURCE_MACHINE = "machine-source";
const SOURCE_DAEMON = "daemon-source";
const SOURCE_DEVICE = "device-source";
const TARGET_MACHINE = "machine-target";
const TARGET_DAEMON = "daemon-target";
const TARGET_DEVICE = "device-target";
const TARGET_PORT = 51999;
const TARGET_TOKEN = "target-endpoint-token";

// The server side models the real V1 source-daemon local `/app` gateway:
// bearer upgrade, app-hello -> app-ready, then app-send-message ->
// app-send-result / app-error. It forwards to the target itself, so the
// connections edge must never open a socket to the target endpoint.
type GatewayMode =
  | "normal"
  | "wrong-identity"
  | "protocol-reject"
  | "post-write-close"
  | "stray-then-correct"
  | "hold-response"
  | "error-absent-id"
  | "error-stray-then-result";

let gatewayMode: GatewayMode = "normal";
let receivedFrames: Array<Record<string, unknown>> = [];
let heldSendResponse: { socket: WebSocket; frame: AppClientFrame } | null = null;
let sendCount = 0;
let authorizationOrder: string[] = [];

function sourceAuth(host: string, port: number): AuthorizedMachineLink {
  return {
    machineId: SOURCE_MACHINE,
    daemonHostId: SOURCE_DAEMON,
    deviceId: SOURCE_DEVICE,
    accountId: "account-source",
    authorizationId: "authz-source",
    capabilities: { channelKinds: ["message"], transportKind: "app-websocket" },
    target: {
      bridgeHost: host,
      bridgePort: port,
      authToken: TOKEN,
      daemonHostId: SOURCE_DAEMON,
    },
    settings: { transportMode: "websocket" },
  };
}

function targetAuth(host: string, port: number): AuthorizedMachineLink {
  return {
    machineId: TARGET_MACHINE,
    daemonHostId: TARGET_DAEMON,
    deviceId: TARGET_DEVICE,
    accountId: "account-source",
    authorizationId: "authz-target",
    capabilities: { channelKinds: ["message"], transportKind: "app-websocket" },
    target: {
      bridgeHost: host,
      bridgePort: port,
      authToken: TARGET_TOKEN,
      daemonHostId: TARGET_DAEMON,
    },
    settings: { transportMode: "websocket" },
  };
}

function sendResult(socket: WebSocket, frame: AppClientFrame): void {
  const payload = frame.payload as { requestId: string; messageId: string };
  const response: AppServerFrame = {
    type: "app-send-result",
    payload: { requestId: payload.requestId, messageId: payload.messageId, status: "received", stage: "received" },
  };
  socket.send(JSON.stringify(response));
}

function rawJson(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function managerFor(host: string, port: number, overrides: {
  authorizeMachine?: (machineId: string) => Promise<AuthorizedMachineLink>;
} = {}) {
  const authorizeMachine = overrides.authorizeMachine ?? (async (machineId: string) => {
    authorizationOrder.push(machineId);
    if (machineId === SOURCE_MACHINE) return sourceAuth(host, port);
    if (machineId === TARGET_MACHINE) return targetAuth("192.0.2.10", TARGET_PORT);
    throw new Error(`unauthorized machine ${machineId}`);
  });
  return createConnectionManager({
    authorizationPort: { authorizeMachine },
    transport: new AppWebSocketTransport(),
  });
}

describe("connections public /app message-send edge (real ws gateway)", () => {
  let server: Server;
  let wsServer: WebSocketServer;
  let port: number;
  let host: string;

  beforeAll(async () => {
    host = "127.0.0.1";
    server = createServer();
    wsServer = new WebSocketServer({ server, path: "/app" });
    wsServer.on("connection", (socket, req) => {
      const mode = gatewayMode;
      const authorization = req.headers.authorization?.trim() ?? "";
      if (authorization !== `Bearer ${TOKEN}`) {
        socket.close(4001, "unauthorized");
        return;
      }
      socket.on("message", (raw) => {
        const frame = rawJson(raw);
        if (!frame) return;
        if (frame.type === "app-hello") {
          const payload = frame.payload as { requestId?: unknown };
          const daemonHostId = mode === "wrong-identity" ? "daemon-someone-else" : SOURCE_DAEMON;
          socket.send(JSON.stringify({
            type: "app-ready",
            payload: {
              requestId: payload.requestId,
              protocolVersion: APP_PROTOCOL_VERSION,
              deviceId: SOURCE_DEVICE,
              daemonHostId,
              capabilities: {},
            },
          }));
          return;
        }
        if (frame.type !== "app-send-message") return;
        sendCount += 1;
        receivedFrames.push(frame);
        const typed = frame as unknown as AppClientFrame;
        const payload = typed.payload as { requestId: string; messageId: string };
        if (mode === "post-write-close") {
          socket.close(1011, "boom");
          return;
        }
        if (mode === "protocol-reject") {
          socket.send(JSON.stringify({
            type: "app-error",
            payload: { requestId: payload.requestId, messageId: payload.messageId, code: "forbidden_role", stage: "admission", message: "role not permitted" },
          }));
          return;
        }
        if (mode === "error-absent-id") {
          // A real V1 initialization failure emits requestId only.
          socket.send(JSON.stringify({
            type: "app-error",
            payload: { requestId: payload.requestId, code: "storage_error", stage: "admission", message: "storage unavailable" },
          }));
          return;
        }
        if (mode === "error-stray-then-result") {
          // An app-error naming another message id must not settle the request;
          // only the following exact result may.
          socket.send(JSON.stringify({
            type: "app-error",
            payload: { requestId: payload.requestId, messageId: "wrong-message-id", code: "storage_error", stage: "admission", message: "stray error" },
          }));
          sendResult(socket, typed);
          return;
        }
        if (mode === "stray-then-correct") {
          // A frame for another request id and a mismatched message id must not
          // settle the request; only the exact correlated result may.
          socket.send(JSON.stringify({
            type: "app-send-result",
            payload: { requestId: "unrelated-request", messageId: "unrelated-message", status: "received", stage: "received" },
          }));
          socket.send(JSON.stringify({
            type: "app-send-result",
            payload: { requestId: payload.requestId, messageId: "wrong-message-id", status: "received", stage: "received" },
          }));
          sendResult(socket, typed);
          return;
        }
        if (mode === "hold-response") {
          heldSendResponse = { socket, frame: typed };
          return;
        }
        sendResult(socket, typed);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
    const address = server.address();
    if (typeof address === "string" || !address) throw new Error("no address");
    port = address.port;
  });

  afterEach(() => {
    gatewayMode = "normal";
    receivedFrames = [];
    heldSendResponse = null;
    sendCount = 0;
    authorizationOrder = [];
  });

  afterAll(async () => {
    for (const client of wsServer.clients) {
      try { client.terminate(); } catch { /* already gone */ }
    }
    await new Promise<void>((resolve) => wsServer.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends an authorized message through the source gateway and returns the correlated result", async () => {
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const result = await manager.requestMessage(channel, {
      v1MessageId: "v1-msg-1",
      targetMachineId: TARGET_MACHINE,
      subject: "hello subject",
      body: "hello body",
    });

    expect(result).toEqual({
      kind: "result",
      requestId: "v1-msg-1",
      messageId: "v1-msg-1",
      status: "received",
      stage: "received",
    });
    expect(sendCount).toBe(1);
    const wire = receivedFrames[0]!;
    expect(wire.type).toBe("app-send-message");
    expect(wire.payload).toEqual({
      requestId: "v1-msg-1",
      messageId: "v1-msg-1",
      target: {
        deviceId: TARGET_DEVICE,
        daemonHostId: TARGET_DAEMON,
        wsUrl: `ws://192.0.2.10:${TARGET_PORT}/app`,
        authToken: TARGET_TOKEN,
      },
      subject: "hello subject",
      body: "hello body",
    });
    // The non-secret selector must never reach the wire.
    expect(JSON.stringify(wire)).not.toContain("targetMachineId");
    expect(JSON.stringify(wire)).not.toContain(TARGET_MACHINE);
    // Target authorization must run before the frame is written to the socket.
    expect(authorizationOrder).toContain(TARGET_MACHINE);
    manager.closeOwnLink(link);
  });

  it("refuses a source gateway that does not prove the authorized daemon identity", async () => {
    gatewayMode = "wrong-identity";
    const manager = managerFor(host, port);
    await expect(manager.connect(SOURCE_MACHINE)).rejects.toMatchObject({ code: "peer_identity_mismatch" });
    expect(sendCount).toBe(0);
  });

  it("does not write a frame when the target machine is not authorized", async () => {
    const manager = managerFor(host, port, {
      authorizeMachine: async (machineId: string) => {
        authorizationOrder.push(machineId);
        if (machineId === SOURCE_MACHINE) return sourceAuth(host, port);
        throw Object.assign(new Error("machine is not authorized"), { code: "MACHINE_NOT_FOUND" });
      },
    });
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    await expect(manager.requestMessage(channel, {
      v1MessageId: "v1-msg-2",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    })).rejects.toMatchObject({ code: "unauthorized" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendCount).toBe(0);
    manager.closeOwnLink(link);
  });

  it("returns a typed rejection when the gateway answers app-error", async () => {
    gatewayMode = "protocol-reject";
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const result = await manager.requestMessage(channel, {
      v1MessageId: "v1-msg-3",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    expect(result).toMatchObject({ kind: "rejected", code: "forbidden_role", stage: "admission" });
    manager.closeOwnLink(link);
  });

  it("returns unknown, never a fabricated success, when the gateway closes after the write", async () => {
    gatewayMode = "post-write-close";
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const result = await manager.requestMessage(channel, {
      v1MessageId: "v1-msg-4",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    expect(result.kind).toBe("unknown");
    if (result.kind === "unknown") {
      expect(result.requestId).toBe("v1-msg-4");
      expect(result.errorRef).toMatch(/v1-msg-4/);
    }
    expect(sendCount).toBe(1);
  });

  it("ignores stray or mismatched frames and settles only on the exact correlation", async () => {
    gatewayMode = "stray-then-correct";
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const result = await manager.requestMessage(channel, {
      v1MessageId: "v1-msg-5",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    expect(result).toMatchObject({ kind: "result", requestId: "v1-msg-5", messageId: "v1-msg-5" });
    manager.closeOwnLink(link);
  });

  it("rejects a duplicate pending v1MessageId without a second send", async () => {
    gatewayMode = "hold-response";
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const first = manager.requestMessage(channel, {
      v1MessageId: "v1-msg-dup",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    await waitFor(() => sendCount === 1);
    await expect(manager.requestMessage(channel, {
      v1MessageId: "v1-msg-dup",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(sendCount).toBe(1);
    if (heldSendResponse) sendResult(heldSendResponse.socket, heldSendResponse.frame);
    await expect(first).resolves.toMatchObject({ kind: "result" });
    manager.closeOwnLink(link);
  });

  it("rejects a request on a closed link before any frame is written", async () => {
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    manager.closeOwnLink(link);
    await expect(manager.requestMessage(channel, {
      v1MessageId: "v1-msg-6",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    })).rejects.toMatchObject({ code: "link_closed" });
    expect(sendCount).toBe(0);
  });

  it("preserves typed protocol details when the gateway omits messageId on app-error", async () => {
    gatewayMode = "error-absent-id";
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const result = await manager.requestMessage(channel, {
      v1MessageId: "v1-msg-absent",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    expect(result).toMatchObject({
      kind: "rejected",
      code: "storage_error",
      stage: "admission",
      cause: "storage unavailable",
    });
    manager.closeOwnLink(link);
  });

  it("ignores an app-error naming another message id and settles on the valid result", async () => {
    gatewayMode = "error-stray-then-result";
    const manager = managerFor(host, port);
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const result = await manager.requestMessage(channel, {
      v1MessageId: "v1-msg-stray-error",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    expect(result).toMatchObject({
      kind: "result",
      requestId: "v1-msg-stray-error",
      messageId: "v1-msg-stray-error",
    });
    manager.closeOwnLink(link);
  });

  it("refuses a channel closed during deferred target authorization and keeps a sibling channel usable", async () => {
    let targetCalls = 0;
    let resolveTarget: ((link: AuthorizedMachineLink) => void) | null = null;
    const manager = managerFor(host, port, {
      authorizeMachine: (machineId: string) => {
        authorizationOrder.push(machineId);
        if (machineId === SOURCE_MACHINE) return Promise.resolve(sourceAuth(host, port));
        targetCalls += 1;
        if (targetCalls === 1) {
          return new Promise<AuthorizedMachineLink>((resolve) => { resolveTarget = resolve; });
        }
        return Promise.resolve(targetAuth("192.0.2.10", TARGET_PORT));
      },
    });
    const link = await manager.connect(SOURCE_MACHINE);
    const channel = await manager.openChannel(link, "message");
    const pending = manager.requestMessage(channel, {
      v1MessageId: "v1-msg-deferred",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    await waitFor(() => resolveTarget !== null);
    // The channel is closed while the destination authorization is in flight;
    // the source link stays connected.
    manager.closeChannel(channel);
    resolveTarget!(targetAuth("192.0.2.10", TARGET_PORT));
    await expect(pending).rejects.toMatchObject({ code: "link_closed" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sendCount).toBe(0);

    // A sibling message channel on the same still-connected link stays usable.
    const sibling = await manager.openChannel(link, "message");
    const ok = await manager.requestMessage(sibling, {
      v1MessageId: "v1-msg-sibling",
      targetMachineId: TARGET_MACHINE,
      subject: "s",
      body: "b",
    });
    expect(ok).toMatchObject({ kind: "result", requestId: "v1-msg-sibling" });
    expect(sendCount).toBe(1);
    manager.closeOwnLink(link);
  });
});
