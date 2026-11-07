import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { APP_PROTOCOL_VERSION } from "../../../packages/shared/src/connection/app-protocol.ts";
import { createAppMessagingPersistence } from "../../../android/src/server/daemon-app-messaging-public.ts";
import { applyReceiptEvidence } from "../../../v2/modules/delivery/src/domain/receipt.ts";
import { createDeliveryPort } from "../../../v2/modules/delivery/src/public/delivery-port.ts";
import type {
  DeliveryRef,
  DeliveryTarget,
} from "../../../v2/modules/delivery/src/domain/receipt.ts";
import type {
  DeliveryAuthorizationPort,
  DeliveryRoutingPort,
  MessageDispatchCommand,
  MessageDispatchPort,
  MessageDispatchResult,
} from "../../../v2/modules/delivery/src/ports/dependencies.ts";
import {
  AppWebSocketTransport,
  createConnectionManager,
} from "../../../v2/modules/connections/src/index.ts";
import type { AuthorizedMachineLink } from "../../../v2/modules/connections/src/index.ts";

// Resolve `ws` from the android package so this script runs from any cwd.
const requireFromAndroid = createRequire(
  new URL("../../../android/package.json", import.meta.url),
);
const { WebSocketServer } = requireFromAndroid("ws") as {
  WebSocketServer: new (options: { server: Server; path: string }) => {
    on(event: string, cb: (...args: unknown[]) => void): void;
    clients: Set<{ terminate(): void }>;
    close(cb: () => void): void;
  };
};

const SOURCE_MACHINE = "machine-source";
const SOURCE_DAEMON = "daemon-source";
const SOURCE_DEVICE = "device-source";
const TARGET_MACHINE = "machine-target";
const TARGET_DAEMON = "daemon-target";
const TARGET_DEVICE = "device-target";
const SOURCE_TOKEN = "test-source-token";
const TARGET_TOKEN = "target-endpoint-token";

const checks: string[] = [];
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  checks.push(`PASS: ${name}`);
}

type AuthContext = Readonly<{
  sourceMachineId: string;
  workspaceId: string;
  actorAccountId: string;
}>;

type WireFrame = Record<string, unknown> & { type?: string; payload?: unknown };

function rawJson(raw: unknown): WireFrame | null {
  try {
    const text =
      typeof raw === "string" ? raw : Buffer.from(raw as ArrayBuffer).toString("utf8");
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as WireFrame)
      : null;
  } catch {
    return null;
  }
}

const sourceAuth = (host: string, port: number): AuthorizedMachineLink => ({
  machineId: SOURCE_MACHINE,
  daemonHostId: SOURCE_DAEMON,
  deviceId: SOURCE_DEVICE,
  accountId: "account-source",
  authorizationId: "authz-source",
  capabilities: { channelKinds: ["message"], transportKind: "app-websocket" },
  target: {
    bridgeHost: host,
    bridgePort: port,
    authToken: SOURCE_TOKEN,
    daemonHostId: SOURCE_DAEMON,
  },
  settings: { transportMode: "websocket" },
});

const targetAuth = (): AuthorizedMachineLink => ({
  machineId: TARGET_MACHINE,
  daemonHostId: TARGET_DAEMON,
  deviceId: TARGET_DEVICE,
  accountId: "account-source",
  authorizationId: "authz-target",
  capabilities: { channelKinds: ["message"], transportKind: "app-websocket" },
  target: {
    bridgeHost: "192.0.2.10",
    bridgePort: 51999,
    authToken: TARGET_TOKEN,
    daemonHostId: TARGET_DAEMON,
  },
  settings: { transportMode: "websocket" },
});

// Minimal model of the real V1 source-daemon local `/app` gateway: bearer
// upgrade, app-hello -> app-ready, then app-send-message -> app-send-result.
async function startGateway(): Promise<{
  server: Server;
  wsServer: {
    clients: Set<{ terminate(): void }>;
    close(cb: () => void): void;
  };
  host: string;
  port: number;
  frames: WireFrame[];
  sendCount: () => number;
}> {
  const host = "127.0.0.1";
  const server = createServer();
  const wsServer = new WebSocketServer({ server, path: "/app" });
  const frames: WireFrame[] = [];
  let sends = 0;

  wsServer.on("connection", (socket: any, req: any) => {
    const authorization = req.headers.authorization?.trim() ?? "";
    if (authorization !== `Bearer ${SOURCE_TOKEN}`) {
      socket.close(4001, "unauthorized");
      return;
    }
    socket.on("message", (raw: unknown) => {
      const frame = rawJson(raw);
      if (!frame) return;
      if (frame.type === "app-hello") {
        const payload = frame.payload as { requestId?: unknown };
        socket.send(
          JSON.stringify({
            type: "app-ready",
            payload: {
              requestId: payload.requestId,
              protocolVersion: APP_PROTOCOL_VERSION,
              deviceId: SOURCE_DEVICE,
              daemonHostId: SOURCE_DAEMON,
              capabilities: {},
            },
          }),
        );
        return;
      }
      if (frame.type !== "app-send-message") return;
      sends += 1;
      frames.push(frame);
      const payload = frame.payload as { requestId: string; messageId: string };
      socket.send(
        JSON.stringify({
          type: "app-send-result",
          payload: {
            requestId: payload.requestId,
            messageId: payload.messageId,
            status: "received",
            stage: "received",
          },
        }),
      );
    });
  });

  await new Promise<void>((resolve) => server.listen(0, host, () => resolve()));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no gateway address");
  return { server, wsServer, host, port: address.port, frames, sendCount: () => sends };
}

const ref: DeliveryRef = Object.freeze({
  sourceMachineId: SOURCE_MACHINE,
  workspaceId: "workspace-a",
  actorAccountId: "actor-a",
  requestId: "request-a",
});

const target: DeliveryTarget = Object.freeze({
  memberId: "member-a",
  machineId: TARGET_MACHINE,
  bindingGeneration: 2,
});

const actor: AuthContext = Object.freeze({
  sourceMachineId: SOURCE_MACHINE,
  workspaceId: "workspace-a",
  actorAccountId: "actor-a",
});

// Consumer-owned adapter: delivery's MessageDispatchPort -> connections
// requestMessage. Only a protocol result that proves the target gateway stored
// the message maps to remote-stored; a bare sent flag never does.
function deliveryDispatchToConnections(
  requestOnChannel: (
    command: MessageDispatchCommand,
  ) => Promise<
    | { kind: "result"; status: string }
    | { kind: "unknown"; errorRef: string }
    | { kind: "rejected"; code: string; errorRef?: string }
  >,
): MessageDispatchPort {
  return {
    async dispatchMessage(command: MessageDispatchCommand): Promise<MessageDispatchResult> {
      const result = await requestOnChannel(command);
      if (result.kind === "result") {
        if (result.status === "received" || result.status === "delivered" || result.status === "consumed") {
          return { kind: "remote-stored", observedAt: new Date().toISOString() };
        }
        if (result.status === "rejected") {
          return { kind: "unavailable", errorRef: "connections.rejected" };
        }
        return { kind: "unknown", errorRef: `connections.${result.status}` };
      }
      if (result.kind === "rejected") {
        return { kind: "unavailable", errorRef: result.errorRef ?? `connections.${result.code}` };
      }
      return { kind: "unknown", errorRef: result.errorRef };
    },
  };
}

const root = await mkdtemp(join(tmpdir(), "zterm-delivery-consumer-blackbox-"));
const gateway = await startGateway();
try {
  const appRootDir = join(root, "app");
  const persistence = createAppMessagingPersistence({ appRootDir }, applyReceiptEvidence);

  // 1. Persistence-owned accept: the immutable command + v1MessageId truth.
  const accepted = await persistence.acceptMessage({
    deliveryRef: ref,
    target,
    kind: "message",
    message: { subject: "delivery subject", body: "delivery body" },
  });
  check("persistence accepts the message", accepted.kind === "created");
  if (accepted.kind !== "created") throw new Error("unreachable");
  const v1MessageId = accepted.receipt.v1MessageId ?? "";
  check("accepted receipt carries a v1MessageId", v1MessageId.length > 0);
  check(
    "accepted receipt is at the accepted stage",
    accepted.receipt.durableStage === "accepted",
  );

  const readAccepted = await persistence.readAcceptedCommand(ref);
  check("readAcceptedCommand returns the persisted command", readAccepted.kind === "found");
  if (readAccepted.kind !== "found") throw new Error("unreachable");
  check(
    "persisted command v1MessageId matches the receipt",
    readAccepted.command.v1MessageId === v1MessageId,
  );

  // 2. Real connections public edge over a real local /app ws gateway.
  const manager = createConnectionManager({
    authorizationPort: {
      async authorizeMachine(machineId: string): Promise<AuthorizedMachineLink> {
        if (machineId === SOURCE_MACHINE) return sourceAuth(gateway.host, gateway.port);
        if (machineId === TARGET_MACHINE) return targetAuth();
        throw new Error(`unauthorized machine ${machineId}`);
      },
    },
    transport: new AppWebSocketTransport(),
  });
  const link = await manager.connect(SOURCE_MACHINE);
  const channel = await manager.openChannel(link, "message");

  // 3. Real delivery public edge, composed with persistence + connections.
  const authorization: DeliveryAuthorizationPort<AuthContext, string> = {
    async authorizeSubmission() {
      return {
        kind: "allowed",
        identity: {
          sourceMachineId: actor.sourceMachineId,
          workspaceId: actor.workspaceId,
          actorAccountId: actor.actorAccountId,
        },
      };
    },
    async authorizeReceiptQuery() {
      return { kind: "allowed" };
    },
    async authorizeResume() {
      return { kind: "allowed" };
    },
  };
  const routing: DeliveryRoutingPort<string> = {
    async resolveTarget() {
      return { kind: "resolved", target };
    },
  };
  const dispatch = deliveryDispatchToConnections(async (command) => {
    const result = await manager.requestMessage(channel, {
      v1MessageId: command.v1MessageId,
      targetMachineId: command.target.machineId,
      subject: command.message.subject ?? "",
      body: command.message.body,
    });
    if (result.kind === "result") {
      return { kind: "result", status: result.status };
    }
    if (result.kind === "rejected") {
      return { kind: "rejected", code: result.code, errorRef: result.errorRef };
    }
    return { kind: "unknown", errorRef: result.errorRef };
  });
  const port = createDeliveryPort<AuthContext, string>({
    authorization,
    routing,
    dispatch,
    receiptStore: persistence,
    acceptedCommand: persistence,
  });

  const resumed = await port.resumeDispatch(actor, ref);
  check("resumeDispatch returns resumed", resumed.kind === "resumed");
  if (resumed.kind !== "resumed") {
    console.error(JSON.stringify(resumed, null, 2));
    throw new Error("resumeDispatch did not resume");
  }
  check(
    "resumed receipt is remote-stored",
    resumed.receipt.durableStage === "remote-stored",
  );
  check("exactly one app-send-message reached the gateway", gateway.sendCount() === 1);
  const wire = gateway.frames[0]!;
  const wirePayload = wire.payload as {
    requestId?: unknown;
    messageId?: unknown;
    target?: unknown;
  };
  check("wire frame is app-send-message", wire.type === "app-send-message");
  check(
    "wire correlation uses the persisted v1MessageId",
    wirePayload.requestId === v1MessageId && wirePayload.messageId === v1MessageId,
  );
  check(
    "non-secret selector never reaches the wire",
    !JSON.stringify(wire).includes("targetMachineId") &&
      !JSON.stringify(wire).includes(TARGET_MACHINE),
  );

  // 4. Same-id recovery must be a no-op: no duplicate frame, already-dispatched.
  const again = await port.resumeDispatch(actor, ref);
  check("second resumeDispatch returns already-dispatched", again.kind === "already-dispatched");
  check("replay sends no second frame", gateway.sendCount() === 1);

  // 5. The durable receipt survives a fresh reopen of the persistence edge.
  const reopened = createAppMessagingPersistence({ appRootDir }, applyReceiptEvidence);
  const reread = await reopened.readReceipt(ref);
  check("fresh reopen finds the receipt", reread.kind === "found");
  if (reread.kind !== "found") throw new Error("unreachable");
  check(
    "durable receipt is remote-stored",
    reread.observation.receipt.durableStage === "remote-stored",
  );
  const reopenCommand = await reopened.readAcceptedCommand(ref);
  check("reopen preserves the accepted command", reopenCommand.kind === "found");
  if (reopenCommand.kind !== "found") throw new Error("unreachable");
  check(
    "reopen preserves v1MessageId",
    reopenCommand.command.v1MessageId === v1MessageId,
  );

  manager.closeOwnLink(link);
} finally {
  for (const client of gateway.wsServer.clients) {
    try {
      client.terminate();
    } catch {
      /* already gone */
    }
  }
  await new Promise<void>((resolve) => gateway.wsServer.close(() => resolve()));
  await new Promise<void>((resolve) => gateway.server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}

console.log(checks.join("\n"));
console.log(`BLACKBOX PASS (${checks.length} checks)`);
