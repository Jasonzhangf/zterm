// Real public consumer for the delivery production default dispatch path.
//
// This composes the accepted owners end to end:
//   delivery.createDeliveryPort
//     -> delivery.createConnectionsDispatchPort (production adapter)
//       -> connections ConnectionManager.requestMessage
//         -> real V1 source-daemon /app gateway (loopback, bearer + identity)
//           -> real V1 target-daemon /app gateway -> real target inbox store
//   accounts createAccountsAuthorizationPort / createWorkspaceAuthorization (auth)
//   members createMembersService (machine + bindingGeneration)
//   persistence createAppMessagingPersistence (durable accepted command + receipt)
//
// It covers: only received/received -> remote-stored, definitive rejection and
// failure, preservation of stage/cause, source-link identity, wrong
// credential/workspace and stale-binding refusals, and lost-result recovery to
// one destination with no duplicate. No inline gateway, no always-allowed
// authorization, no test-only mapping.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createAppMessagingPersistence } from "../../../android/src/server/daemon-app-messaging-public.ts";
import { createDaemonAppMessagingRuntime } from "../../../android/src/server/daemon-app-messaging-runtime.ts";
import { createDaemonAppGateway } from "../../../android/src/server/daemon-app-websocket-runtime.ts";
import { DaemonAppMessagingStore } from "../../../android/src/server/daemon-app-messaging-store.ts";
import { applyReceiptEvidence } from "../../../v2/modules/delivery/src/domain/receipt.ts";
import {
  createConnectionsDispatchPort,
  createDeliveryPort,
} from "../../../v2/modules/delivery/src/public/delivery-port.ts";
import type {
  DeliveryAuthorizationPort,
  DeliveryRef,
  DeliveryRoutingPort,
  DeliveryTarget,
} from "../../../v2/modules/delivery/src/public/delivery-port.ts";
import {
  AppWebSocketTransport,
  ConnectionError,
  createConnectionManager,
} from "../../../v2/modules/connections/src/index.ts";
import {
  AccountsError,
  AuthService,
  MachineService,
  createAccountsAuthorizationPort,
  createFileAccountAuthorizationStore,
  createWorkspaceAuthorization,
} from "../../../v2/modules/accounts/src/public/contracts.ts";
import {
  createBindingStore,
  createMembersService,
} from "../../../v2/modules/members/src/public/index.mjs";

const requireFromAndroid = createRequire(
  new URL("../../../android/package.json", import.meta.url),
);
const { WebSocket } = requireFromAndroid("ws") as {
  WebSocket: new (url: string, options?: unknown) => {
    on(event: string, cb: (...args: unknown[]) => void): void;
    once(event: string, cb: (...args: unknown[]) => void): void;
    send(data: string): void;
    close(code?: number, reason?: string): void;
    terminate?: () => void;
    readyState: number;
  };
};

const ACCOUNT_ID = "acct-a";
const LOGIN = "alice";
const SESSION_TOKEN = "session-token-a";
const WORKSPACE_ID = "workspace-a";
const MEMBER_ID = "member-a";
const SOURCE_MACHINE = "machine-source";
const SOURCE_DAEMON = "daemon-source";
const SOURCE_DEVICE = "device-source";
const SOURCE_TOKEN = "source-gateway-token";
const TARGET_MACHINE = "machine-target";
const TARGET_DAEMON = "daemon-target";
const TARGET_DEVICE = "device-target";
const TARGET_TOKEN = "target-gateway-token";
const UPDATED_AT = "2026-11-07T00:00:00.000Z";
const PEER_REQUEST_TIMEOUT_MS = 1200;

const checks: string[] = [];
function check(name: string, condition: boolean): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  checks.push(`PASS: ${name}`);
}

type Actor = Readonly<{ token: string; workspaceId: string }>;

const root = await mkdtemp(join(tmpdir(), "zterm-delivery-consumer-blackbox-"));
const sourceDir = join(root, "source");
const targetDir = join(root, "target");

// --- Lost-result fault injection at the source runtime's documented peer
// socket factory. It drops one incoming peer result frame; the target gateway
// has already durably stored the inbox record, so this models a real lost
// remote response instead of a fabricated outcome.
let dropNextPeerResult = false;
function createPeerWebSocket(url: string, authToken: string) {
  const real = new WebSocket(url, {
    headers: { Authorization: `Bearer ${authToken}` },
  });
  const realOn = real.on.bind(real);
  real.on = (event: string, handler: (...args: unknown[]) => void) => {
    if (event !== "message") return realOn(event, handler);
    return realOn("message", (data: unknown, isBinary: unknown) => {
      if (dropNextPeerResult) {
        let type: string | undefined;
        try {
          type = JSON.parse(String(data)).type;
        } catch {
          type = undefined;
        }
        if (type === "app-send-result" || type === "app-error") {
          dropNextPeerResult = false;
          return;
        }
      }
      handler(data, isBinary);
    });
  };
  return real;
}

interface StartDaemonInput {
  appRootDir: string;
  deviceId: string;
  daemonHostId: string;
  token: string;
  peerRequestTimeoutMs?: number;
  peerWebSocket?: (url: string, authToken: string) => unknown;
}

async function startDaemon(input: StartDaemonInput) {
  const runtime = createDaemonAppMessagingRuntime({
    appRootDir: input.appRootDir,
    deviceId: input.deviceId,
    daemonHostId: input.daemonHostId,
    ...(input.peerRequestTimeoutMs === undefined
      ? {}
      : { peerRequestTimeoutMs: input.peerRequestTimeoutMs }),
    ...(input.peerWebSocket === undefined
      ? {}
      : { createWebSocket: input.peerWebSocket }),
  });
  await runtime.initialize();
  const gateway = createDaemonAppGateway({
    requiredAuthToken: input.token,
    daemonHostId: input.daemonHostId,
    deviceId: input.deviceId,
    messaging: runtime,
  });
  const server = createServer();
  server.on("upgrade", gateway.handleServerUpgrade);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("no daemon address");
  return { runtime, gateway, server, host: "127.0.0.1", port: address.port };
}

const sourceDaemon = await startDaemon({
  appRootDir: sourceDir,
  deviceId: SOURCE_DEVICE,
  daemonHostId: SOURCE_DAEMON,
  token: SOURCE_TOKEN,
  peerRequestTimeoutMs: PEER_REQUEST_TIMEOUT_MS,
  peerWebSocket: createPeerWebSocket,
});
const targetDaemon = await startDaemon({
  appRootDir: targetDir,
  deviceId: TARGET_DEVICE,
  daemonHostId: TARGET_DAEMON,
  token: TARGET_TOKEN,
});
const targetStore = new DaemonAppMessagingStore({ appRootDir: targetDir });

async function inboxCountFor(messageId: string): Promise<number> {
  const records = await targetStore.listInboxRecords();
  return records.filter((record) => record.messageId === messageId).length;
}

// --- Real accounts authorization: session, machine ownership, route identity.
const authority = {
  async register(): Promise<never> {
    throw new Error("register is not used by this consumer");
  },
  async authenticate(): Promise<never> {
    throw new Error("authenticate is not used by this consumer");
  },
  async validateSession(token: string) {
    if (token !== SESSION_TOKEN) throw new AccountsError("AUTHENTICATION_REQUIRED", 401);
    return { accessToken: SESSION_TOKEN, accountId: ACCOUNT_ID, loginName: LOGIN };
  },
  async logout(): Promise<void> {
    /* the consumer never logs out */
  },
};
const authService = new AuthService({ authority });
const machineReg = {
  async listMachines(token: string) {
    if (token !== SESSION_TOKEN) return [];
    return [
      {
        machineId: SOURCE_MACHINE,
        ownerAccountId: ACCOUNT_ID,
        legacyDeviceId: SOURCE_DEVICE,
        displayName: SOURCE_MACHINE,
        status: "active" as const,
        createdAt: UPDATED_AT,
      },
      {
        machineId: TARGET_MACHINE,
        ownerAccountId: ACCOUNT_ID,
        legacyDeviceId: TARGET_DEVICE,
        displayName: TARGET_MACHINE,
        status: "active" as const,
        createdAt: UPDATED_AT,
      },
    ];
  },
  async enroll(): Promise<never> {
    throw new Error("enroll is not used by this consumer");
  },
  async verifyPossession(): Promise<never> {
    throw new Error("verifyPossession is not used by this consumer");
  },
  async revokeMachine(): Promise<never> {
    throw new Error("revokeMachine is not used by this consumer");
  },
};
const machineService = new MachineService({
  machineReg,
  verifySession: (token: string) => authService.verifySession(token),
});
const DEVICE_BY_MACHINE: Record<string, string> = {
  [SOURCE_MACHINE]: SOURCE_DEVICE,
  [TARGET_MACHINE]: TARGET_DEVICE,
};
const routes = {
  async get(machineId: string) {
    if (machineId === SOURCE_MACHINE) {
      return {
        machineId,
        daemonHostId: SOURCE_DAEMON,
        capabilities: { channelKinds: ["message"], transportKind: "app-websocket" },
        target: {
          bridgeHost: sourceDaemon.host,
          bridgePort: sourceDaemon.port,
          authToken: SOURCE_TOKEN,
          daemonHostId: SOURCE_DAEMON,
          transportMode: "websocket" as const,
        },
        settings: { transportMode: "websocket" as const },
      };
    }
    if (machineId === TARGET_MACHINE) {
      return {
        machineId,
        daemonHostId: TARGET_DAEMON,
        capabilities: { channelKinds: ["message"], transportKind: "app-websocket" },
        target: {
          bridgeHost: targetDaemon.host,
          bridgePort: targetDaemon.port,
          authToken: TARGET_TOKEN,
          daemonHostId: TARGET_DAEMON,
          transportMode: "websocket" as const,
        },
        settings: { transportMode: "websocket" as const },
      };
    }
    return undefined;
  },
};
const accountsPort = createAccountsAuthorizationPort({
  token: SESSION_TOKEN,
  authService,
  machineService,
  routes,
});
// connections needs the accounts-owned device identity beside the verified
// link; it comes from the same accounts machine registration, never a caller
// input.
const connectionsAuth = {
  async authorizeMachine(machineId: string) {
    const link = await accountsPort.authorizeMachine(machineId);
    const deviceId = DEVICE_BY_MACHINE[machineId];
    if (!deviceId) throw new Error(`no registered device identity for ${machineId}`);
    return { ...link, deviceId };
  },
};

// --- Real workspace authorization (session + explicit workspace grant).
const grantStore = createFileAccountAuthorizationStore(join(root, "authorization.json"));
await grantStore.putGrant({
  accountId: ACCOUNT_ID,
  scopes: ["members:read", "members:write", "delivery:send"],
  allWorkspaces: false,
  workspaceIds: [WORKSPACE_ID],
  memberIds: [MEMBER_ID],
  updatedAt: UPDATED_AT,
});
const workspaceAuth = createWorkspaceAuthorization({ authService, store: grantStore });

// --- Real members binding (machine identity + monotonic bindingGeneration).
const members = createMembersService({
  store: createBindingStore(join(root, "bindings.json")),
  auth: workspaceAuth,
  organization: {
    async getMember(memberId: string) {
      if (memberId !== MEMBER_ID) return null;
      return { memberId: MEMBER_ID, workspaceId: WORKSPACE_ID };
    },
  },
  hostProbe: null,
});
await members.configureRuntime({
  token: SESSION_TOKEN,
  memberId: MEMBER_ID,
  machineId: TARGET_MACHINE,
  hostKind: "daemon",
  agentKind: "v2",
  launchProfileRef: "profile-v2",
});
await members.bindSession({
  token: SESSION_TOKEN,
  memberId: MEMBER_ID,
  sessionId: "session-1",
  anchor: "anchor-1",
  expectedGeneration: 0,
});

// --- Real connections public awaited-send edge over the source gateway.
const manager = createConnectionManager({
  authorizationPort: connectionsAuth,
  transport: new AppWebSocketTransport(),
});
const sourceLink = await manager.connect(SOURCE_MACHINE);
const messageChannel = await manager.openChannel(sourceLink, "message");

let channelSendCount = 0;
const sendChannel = {
  async sendMessage(request: {
    v1MessageId: string;
    targetMachineId: string;
    subject: string;
    body: string;
  }) {
    channelSendCount += 1;
    try {
      const result = await manager.requestMessage(messageChannel, request);
      if (result.kind === "result") {
        return { kind: "result" as const, status: result.status, stage: result.stage };
      }
      if (result.kind === "unknown") {
        return {
          kind: "unknown" as const,
          errorRef: result.errorRef,
          ...(result.cause === undefined ? {} : { cause: result.cause }),
        };
      }
      return {
        kind: "rejected" as const,
        code: result.code,
        ...(result.stage === undefined ? {} : { stage: result.stage }),
        ...(result.errorRef === undefined ? {} : { errorRef: result.errorRef }),
        ...(result.cause === undefined ? {} : { cause: result.cause }),
      };
    } catch (error) {
      if (error instanceof ConnectionError) {
        // requestMessage only throws before any payload write.
        return { kind: "rejected" as const, code: error.code, cause: error.message };
      }
      throw error;
    }
  },
};

// --- Delivery port: real auth/routing/dispatch/receipt composition.
const persistence = createAppMessagingPersistence({ appRootDir: sourceDir }, applyReceiptEvidence);
const actor: Actor = Object.freeze({ token: SESSION_TOKEN, workspaceId: WORKSPACE_ID });

const authorization: DeliveryAuthorizationPort<Actor, string> = {
  async authorizeSubmission(caller, _targetAddress) {
    let context;
    try {
      context = await workspaceAuth.verify(caller.token);
    } catch (error) {
      return {
        kind: "denied",
        errorRef: error instanceof AccountsError ? error.code : "delivery.auth.invalid-credential",
      };
    }
    if (context.workspaces !== "*" && !context.workspaces?.includes(caller.workspaceId)) {
      return { kind: "denied", errorRef: "WORKSPACE_AUTHORIZATION_REQUIRED" };
    }
    return {
      kind: "allowed",
      identity: {
        sourceMachineId: SOURCE_MACHINE,
        workspaceId: caller.workspaceId,
        actorAccountId: context.accountId,
      },
    };
  },
  async authorizeReceiptQuery(caller, ref) {
    try {
      const context = await workspaceAuth.verify(caller.token);
      if (context.workspaces !== "*" && !context.workspaces?.includes(ref.workspaceId)) {
        return { kind: "denied", errorRef: "WORKSPACE_AUTHORIZATION_REQUIRED" };
      }
      return { kind: "allowed" };
    } catch (error) {
      return {
        kind: "denied",
        errorRef: error instanceof AccountsError ? error.code : "delivery.auth.invalid-credential",
      };
    }
  },
  async authorizeResume({ actor: caller, ref, target }) {
    try {
      const context = await workspaceAuth.verify(caller.token);
      if (context.workspaces !== "*" && !context.workspaces?.includes(ref.workspaceId)) {
        return { kind: "denied", errorRef: "WORKSPACE_AUTHORIZATION_REQUIRED" };
      }
      const binding = await members.getRuntimeBinding(MEMBER_ID);
      if (binding.bindingGeneration !== target.bindingGeneration) {
        return { kind: "denied", errorRef: "TARGET_BINDING_STALE" };
      }
      return { kind: "allowed" };
    } catch (error) {
      return {
        kind: "denied",
        errorRef: error instanceof Error ? error.message : "delivery.auth.resume-denied",
      };
    }
  },
};
const routing: DeliveryRoutingPort<string> = {
  async resolveTarget() {
    try {
      const binding = await members.getRuntimeBinding(MEMBER_ID);
      return {
        kind: "resolved",
        target: {
          memberId: binding.memberId,
          machineId: binding.machineId,
          bindingGeneration: binding.bindingGeneration,
        },
      };
    } catch (error) {
      return {
        kind: "unavailable",
        errorRef: error instanceof Error ? error.message : "delivery.routing.unavailable",
      };
    }
  },
};
const dispatch = createConnectionsDispatchPort(sendChannel, {
  sourceMachineId: SOURCE_MACHINE,
});
const port = createDeliveryPort<Actor, string>({
  authorization,
  routing,
  dispatch,
  receiptStore: persistence,
  acceptedCommand: persistence,
});

// --- 0. Production adapter mapping tiers (definitive vs unknown vs stored).
async function mappingCheck(observation: unknown) {
  const adapter = createConnectionsDispatchPort(
    { async sendMessage() { return observation as never; } },
    { sourceMachineId: SOURCE_MACHINE },
  );
  return adapter.dispatchMessage({
    deliveryRef: {
      sourceMachineId: SOURCE_MACHINE,
      workspaceId: WORKSPACE_ID,
      actorAccountId: ACCOUNT_ID,
      requestId: "mapping",
    },
    target: { memberId: MEMBER_ID, machineId: TARGET_MACHINE, bindingGeneration: 1 },
    message: { subject: "s", body: "b" },
    v1MessageId: "mapping-id",
  });
}
check(
  "adapter maps received/received to remote-stored",
  (await mappingCheck({ kind: "result", status: "received", stage: "received" })).kind
    === "remote-stored",
);
{
  const delivered = await mappingCheck({ kind: "result", status: "delivered", stage: "received" });
  check(
    "adapter keeps delivered/received unconfirmed as unknown",
    delivered.kind === "unknown",
  );
  const consumed = await mappingCheck({ kind: "result", status: "consumed", stage: "received" });
  check("adapter keeps consumed/received unconfirmed as unknown", consumed.kind === "unknown");
  const partial = await mappingCheck({ kind: "result", status: "received", stage: "sent" });
  check("adapter keeps received/sent unconfirmed as unknown", partial.kind === "unknown");
  const rejected = await mappingCheck({
    kind: "rejected",
    code: "forbidden_role",
    stage: "admission",
    cause: "role not permitted",
  });
  check(
    "adapter maps a definitive protocol rejection to failed with stage",
    rejected.kind === "failed"
      && rejected.errorChain?.[0]?.code === "forbidden_role"
      && rejected.errorChain?.[0]?.stage === "admission",
  );
  const storageError = await mappingCheck({
    kind: "rejected",
    code: "storage_error",
    stage: "admission",
    cause: "disk full",
  });
  check(
    "adapter keeps storage_error unknown with typed code/stage/cause",
    storageError.kind === "unknown"
      && storageError.errorChain?.[0]?.code === "storage_error"
      && storageError.errorChain?.[0]?.stage === "admission"
      && storageError.errorChain?.[0]?.message === "disk full",
  );
  const lost = await mappingCheck({ kind: "unknown", errorRef: "app-send:x:transport", cause: "closed" });
  check("adapter keeps a post-write transport loss unknown", lost.kind === "unknown");
}

// --- 1. Normal public send reaches real target storage.
const normal = await port.submitMessage(
  actor,
  MEMBER_ID,
  "request-normal",
  { subject: "normal subject", body: "normal body" },
);
check("normal submit is accepted and created", normal.kind === "accepted" && normal.disposition === "created");
if (normal.kind !== "accepted") throw new Error(JSON.stringify(normal));
check("normal receipt is remote-stored", normal.receipt.durableStage === "remote-stored");
check("normal receipt carries a v1MessageId", (normal.receipt.v1MessageId ?? "").length > 0);
check(
  "deliveryRef.sourceMachineId matches the real source link",
  normal.receipt.deliveryRef.sourceMachineId === SOURCE_MACHINE,
);
{
  const v1 = normal.receipt.v1MessageId ?? "";
  check("real target inbox holds exactly one record", (await inboxCountFor(v1)) === 1);
  const [record] = (await targetStore.listInboxRecords()).filter((r) => r.messageId === v1);
  check(
    "target record preserves subject and body",
    record?.subject === "normal subject" && record?.body === "normal body",
  );
  check("target record came from the real source daemon", record?.senderDaemonHostId === SOURCE_DAEMON);
}
check("exactly one channel send for the normal message", channelSendCount === 1);

// --- 1b. Missing subject stays accepted and refuses dispatch (no send).
const beforeNoSubjectSends = channelSendCount;
const noSubject = await port.submitMessage(
  actor,
  MEMBER_ID,
  "request-no-subject",
  { body: "body without subject" },
);
check(
  "missing subject returns dispatch-unavailable with SUBJECT_REQUIRED",
  noSubject.kind === "dispatch-unavailable"
    && noSubject.errorRef === "SUBJECT_REQUIRED"
    && noSubject.receipt.durableStage === "accepted",
);
check("missing subject writes no send", channelSendCount === beforeNoSubjectSends);

// --- 2. Lost remote response -> same persisted ID recovers to one destination.
dropNextPeerResult = true;
const recovery = await port.submitMessage(
  actor,
  MEMBER_ID,
  "request-recovery",
  { subject: "recovery subject", body: "recovery body" },
);
check("first recovery attempt stays unknown", recovery.kind === "dispatch-unknown");
if (recovery.kind !== "dispatch-unknown") throw new Error(JSON.stringify(recovery));
check("lost-result receipt keeps the accepted stage", recovery.receipt.durableStage === "accepted");
const recoveryV1 = recovery.receipt.v1MessageId ?? "";
check("target stored the message despite the lost result", (await inboxCountFor(recoveryV1)) === 1);
dropNextPeerResult = false;
const resumed = await port.resumeDispatch(actor, recovery.receipt.deliveryRef);
check("resume reaches remote-stored", resumed.kind === "resumed");
if (resumed.kind !== "resumed") throw new Error(JSON.stringify(resumed));
check("resumed receipt is remote-stored", resumed.receipt.durableStage === "remote-stored");
check(
  "resume reused the same persisted v1MessageId",
  resumed.receipt.v1MessageId === recoveryV1,
);
check(
  "recovery reaches exactly one destination message (no duplicate)",
  (await inboxCountFor(recoveryV1)) === 1,
);
check("recovery used a real second send attempt", channelSendCount === 3);

// --- 3. Stale binding refuses the recovery send.
dropNextPeerResult = true;
const stale = await port.submitMessage(
  actor,
  MEMBER_ID,
  "request-stale",
  { subject: "stale subject", body: "stale body" },
);
check("stale setup attempt stays unknown", stale.kind === "dispatch-unknown");
if (stale.kind !== "dispatch-unknown") throw new Error(JSON.stringify(stale));
dropNextPeerResult = false;
await members.bindSession({
  token: SESSION_TOKEN,
  memberId: MEMBER_ID,
  sessionId: "session-2",
  anchor: "anchor-2",
  expectedGeneration: 1,
});
const beforeStaleResume = channelSendCount;
const staleResume = await port.resumeDispatch(actor, stale.receipt.deliveryRef);
check(
  "stale binding refuses resume with an explicit refusal",
  staleResume.kind === "rejected" && staleResume.code === "AUTHORIZATION_DENIED",
);
check("stale binding refusal writes no new send", channelSendCount === beforeStaleResume);

// --- 4. Wrong credential and wrong workspace refuse before any send.
const beforeDenied = channelSendCount;
const badCredential = await port.submitMessage(
  { token: "wrong-token", workspaceId: WORKSPACE_ID },
  MEMBER_ID,
  "request-bad-credential",
  { subject: "s", body: "b" },
);
check(
  "wrong credential is refused before dispatch",
  badCredential.kind === "rejected" && badCredential.code === "AUTHORIZATION_DENIED",
);
const badWorkspace = await port.submitMessage(
  { token: SESSION_TOKEN, workspaceId: "workspace-other" },
  MEMBER_ID,
  "request-bad-workspace",
  { subject: "s", body: "b" },
);
check(
  "wrong workspace is refused before dispatch",
  badWorkspace.kind === "rejected" && badWorkspace.code === "AUTHORIZATION_DENIED",
);
check("refusals write no send", channelSendCount === beforeDenied);

// --- 5. Production adapter refuses a ref from a different source machine.
{
  const guard = createConnectionsDispatchPort(sendChannel, {
    sourceMachineId: SOURCE_MACHINE,
  });
  const beforeGuard = channelSendCount;
  const mismatch = await guard.dispatchMessage({
    deliveryRef: {
      sourceMachineId: "machine-elsewhere",
      workspaceId: WORKSPACE_ID,
      actorAccountId: ACCOUNT_ID,
      requestId: "guard",
    },
    target: { memberId: MEMBER_ID, machineId: TARGET_MACHINE, bindingGeneration: 2 },
    message: { subject: "s", body: "b" },
    v1MessageId: "guard-id",
  });
  check(
    "adapter refuses a mismatched source machine",
    mismatch.kind === "unavailable"
      && mismatch.errorRef === "delivery.dispatch.source-mismatch",
  );
  check("source mismatch guard writes no send", channelSendCount === beforeGuard);
}

// --- Teardown (no process kill: only explicit owned resources).
manager.closeOwnLink(sourceLink);
sourceDaemon.gateway.dispose();
sourceDaemon.runtime.dispose();
targetDaemon.gateway.dispose();
targetDaemon.runtime.dispose();
await new Promise<void>((resolve) => sourceDaemon.server.close(() => resolve()));
await new Promise<void>((resolve) => targetDaemon.server.close(() => resolve()));
await rm(root, { recursive: true, force: true });

console.log(checks.join("\n"));
console.log(`BLACKBOX PASS (${checks.length} checks)`);
