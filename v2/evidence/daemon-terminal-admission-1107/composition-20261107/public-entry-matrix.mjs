import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createConnectionManager, V1TraversalTransport } from "../../../modules/connections/src/index.ts";
import { resolveAuthorizedTerminalDirectory } from "../../../modules/connections/src/public/index.mjs";
import { createTerminalAdmission } from "../../../modules/daemon/src/terminal-admission.mjs";
import { createDaemon } from "../../../modules/daemon/src/server.mjs";
import { createConnectionMachineTerminal } from "../../../modules/daemon/src/machine-terminal-consumer.mjs";
import { createV1MuxFixture } from "../../../modules/terminal/tests/v1-mux-fixture.mjs";
import {
  createOrganizationService,
  createOrganizationStore,
} from "../../../modules/organization/src/public/index.mjs";
import {
  createBindingStore,
  createMembersService,
} from "../../../modules/members/src/public/index.mjs";
import {
  createRoutingDevAuth,
  createRoutingService,
} from "../../../modules/routing/src/public/index.mjs";

const SEED_TOKEN = "matrix-seed-token";
const CALLER_TOKEN = "matrix-caller-token";
const AUTH_TOKEN = "matrix-v1-token";
const MACHINE_ID = "machine-matrix";
const DAEMON_HOST_ID = "daemon-matrix";
const ROOT = join(tmpdir(), "zterm-public-entry-matrix");

const cases = [];
let sequence = 0;

function tmux(socket, args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function record(name, expected, actual, sideEffects) {
  const passed = actual.status === expected.status
    && actual.code === expected.code
    && sideEffects.channelOpens === expected.channelOpens
    && sideEffects.inputs === expected.inputs;
  cases.push({ name, expected, actual, sideEffects, passed });
  return passed;
}

async function startTerminalPair() {
  sequence += 1;
  await import("node:fs/promises").then(({ mkdir }) => mkdir(ROOT, { recursive: true }));
  const id = `${process.pid}-${sequence}`;
  const socket = join(ROOT, `${id}.sock`);
  const names = [`matrix-${id}-a`, `matrix-${id}-b`];
  for (const name of names) {
    tmux(socket, ["new-session", "-d", "-s", name, "-x", "90", "-y", "24"]);
  }
  return {
    socket,
    names,
    close() {
      for (const name of names) {
        try {
          tmux(socket, ["kill-session", "-t", name]);
        } catch {
          // The dedicated session is already gone.
        }
      }
    },
  };
}

async function startFixture() {
  const terminal = await startTerminalPair();
  const fixture = createV1MuxFixture({
    tmuxSocket: terminal.socket,
    authToken: AUTH_TOKEN,
    daemonHostId: DAEMON_HOST_ID,
  });
  const { port } = await fixture.listen();
  return {
    ...terminal,
    fixture,
    port,
    async close() {
      await fixture.close();
      terminal.close();
    },
  };
}

async function createHarness(target) {
  const dir = await mkdtemp(join(tmpdir(), "zterm-matrix-members-"));
  const seedAuth = createRoutingDevAuth({
    accounts: {
      [SEED_TOKEN]: {
        accountId: "acct-matrix-seed",
        scopes: ["org:write", "members:read", "members:write", "routing:resolve"],
        workspaces: "*",
      },
    },
  });
  const organization = createOrganizationService({
    store: createOrganizationStore(join(dir, "organization.json")),
    auth: seedAuth,
  });
  const members = createMembersService({
    store: createBindingStore(join(dir, "members.json")),
    auth: seedAuth,
    organization,
  });
  const workspace = await organization.createWorkspace({ token: SEED_TOKEN, name: "Matrix" });
  const group = await organization.createGroup({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    name: "team",
    expectedRevision: workspace.revision,
  });
  const member = await organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: group.groupId,
    name: "Worker",
    expectedRevision: group.revision,
  });
  await members.configureRuntime({
    token: SEED_TOKEN,
    memberId: member.memberId,
    machineId: MACHINE_ID,
    hostKind: "tmux",
    agentKind: "codex",
    launchProfileRef: "lp-matrix",
  });
  let binding = await members.bindSession({
    token: SEED_TOKEN,
    memberId: member.memberId,
    sessionId: "sess-matrix",
    anchor: "pane:0",
    expectedGeneration: 0,
    ...(target ? { terminalTarget: { backend: target.backend, stableId: target.stableId } } : {}),
  });
  const callerAuth = createRoutingDevAuth({
    accounts: {
      [CALLER_TOKEN]: {
        accountId: "acct-matrix-caller",
        scopes: ["routing:resolve"],
        workspaces: [workspace.workspaceId],
        members: [member.memberId],
      },
    },
  });
  const routing = createRoutingService({ organization, members, auth: callerAuth });

  async function bindTarget(nextTarget) {
    binding = await members.bindSession({
      token: SEED_TOKEN,
      memberId: member.memberId,
      sessionId: `sess-matrix-${binding.generation + 1}`,
      anchor: "pane:0",
      expectedGeneration: binding.generation,
      terminalTarget: { backend: nextTarget.backend, stableId: nextTarget.stableId },
    });
    return binding;
  }

  return {
    organization,
    members,
    routing,
    callerAuth,
    workspace,
    group,
    member,
    get binding() {
      return binding;
    },
    bindTarget,
  };
}

function createManager({ port, daemonHostId = DAEMON_HOST_ID } = {}) {
  return createConnectionManager({
    authorizationPort: {
      async authorizeMachine(machineId) {
        return {
          machineId,
          daemonHostId,
          accountId: "account-matrix",
          authorizationId: "authorization-matrix",
          capabilities: { channelKinds: ["terminal"], transportKind: "websocket" },
          target: {
            bridgeHost: "127.0.0.1",
            bridgePort: port,
            authToken: AUTH_TOKEN,
            daemonHostId,
            relayHostId: daemonHostId,
            relayEndpointCandidates: [],
            transportMode: "websocket",
          },
          settings: { transportMode: "websocket" },
        };
      },
    },
    transport: new V1TraversalTransport(),
  });
}

async function readCatalog(manager) {
  const directory = await resolveAuthorizedTerminalDirectory({
    connectionManager: manager,
    machineId: MACHINE_ID,
  });
  try {
    return directory.entries;
  } finally {
    directory.close();
  }
}

function createAdmission(harness, machineTerminal) {
  return createTerminalAdmission({
    auth: harness.callerAuth,
    members: harness.members,
    routing: harness.routing,
    machineTerminal,
    terminal: {
      listSessions: async () => [],
      input: async () => ({}),
    },
    log: () => {},
  });
}

async function startHttpDaemon(harness, machineTerminal) {
  const daemon = createDaemon({
    v2Token: CALLER_TOKEN,
    admission: {
      auth: harness.callerAuth,
      members: harness.members,
      routing: harness.routing,
      machineTerminal,
    },
    log: () => {},
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  return {
    daemon,
    base: `http://127.0.0.1:${port}`,
    async close() {
      await new Promise((resolve) => daemon.server.close(resolve));
    },
  };
}

function inputBody(harness, target, overrides = {}) {
  return {
    workspaceId: harness.workspace.workspaceId,
    memberId: harness.member.memberId,
    machineId: MACHINE_ID,
    groupPath: harness.group.path,
    expectedGeneration: harness.binding.generation,
    target: { backend: target.backend, stableId: target.stableId },
    data: "printf 'GREEN_CR_MARKER'\\r",
    ...overrides,
  };
}

async function postInput(base, body, token = CALLER_TOKEN) {
  const response = await fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for a condition.");
}

function sideEffects(fixture) {
  return {
    channelOpens: fixture.recorded.channelOpen.length,
    inputs: fixture.recorded.input.length,
  };
}

async function runGreenAndHttpMatrix() {
  const fixture = await startFixture();
  try {
    const readerManager = createManager({ port: fixture.port });
    const catalog = await readCatalog(readerManager);
    assert.equal(catalog.length, 2, "the fixture must expose both tmux sessions");
    const targetA = catalog.find((entry) => entry.name === fixture.names[0]);
    const targetB = catalog.find((entry) => entry.name === fixture.names[1]);
    assert.ok(targetA && targetB);

    const harness = await createHarness(targetA);
    const manager = createManager({ port: fixture.port });
    const machineTerminal = createConnectionMachineTerminal({ connectionManager: manager });
    const admission = createAdmission(harness, machineTerminal);

    const admitted = await admission.admit({
      callerToken: CALLER_TOKEN,
      workspaceId: harness.workspace.workspaceId,
      memberId: harness.member.memberId,
      machineId: MACHINE_ID,
      groupPath: harness.group.path,
      expectedGeneration: harness.binding.generation,
      target: targetA,
    });
    record("green-admit", {
      status: "ok",
      code: null,
      channelOpens: 0,
      inputs: 0,
    }, { status: "ok", code: null }, sideEffects(fixture.fixture));
    assert.equal(admitted.session.stableId, targetA.stableId);

    const input = await admission.forwardInput({
      callerToken: CALLER_TOKEN,
      workspaceId: harness.workspace.workspaceId,
      memberId: harness.member.memberId,
      machineId: MACHINE_ID,
      groupPath: harness.group.path,
      expectedGeneration: harness.binding.generation,
      target: targetA,
      data: "printf 'GREEN_CR_MARKER'\\r",
    });
    assert.equal(input.session.stableId, targetA.stableId);
    await waitFor(() => fixture.fixture.recorded.input.length >= 1);
    assert.equal(fixture.fixture.recorded.input.at(-1).data, "printf 'GREEN_CR_MARKER'\\r");
    await waitFor(() => tmux(fixture.socket, ["capture-pane", "-p", "-t", fixture.names[0]])
      .includes("GREEN_CR_MARKER"));
    record("green-raw-input", {
      status: "ok",
      code: null,
      channelOpens: 1,
      inputs: 1,
    }, { status: "ok", code: null }, sideEffects(fixture.fixture));

    const httpDaemon = await startHttpDaemon(harness, machineTerminal);
    try {
      const streamQuery = new URLSearchParams({
        workspaceId: harness.workspace.workspaceId,
        memberId: harness.member.memberId,
        machineId: MACHINE_ID,
        groupPath: harness.group.path,
        expectedGeneration: String(harness.binding.generation),
        backend: targetA.backend,
        stableId: targetA.stableId,
      });
      const stream = await fetch(`${httpDaemon.base}/api/terminal/stream?${streamQuery}`, {
        headers: { authorization: `Bearer ${CALLER_TOKEN}` },
      });
      if (stream.status !== 200) {
        console.error("stream-error", stream.status, await stream.text());
      }
      assert.equal(stream.status, 200);
      const reader = stream.body.getReader();
      const decoder = new TextDecoder();
      let text = "";
      while (!text.includes("event: ready")) {
        const chunk = await reader.read();
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      assert.match(text, /event: ready/u);
      await reader.cancel();
      record("green-stream-ready", {
        status: 200,
        code: null,
        channelOpens: 1,
        inputs: 1,
      }, { status: stream.status, code: null }, sideEffects(fixture.fixture));

      let result = await postInput(httpDaemon.base, inputBody(harness, targetA, {
        data: "printf 'GREEN_HTTP_MARKER'\\r",
      }));
      assert.equal(result.response.status, 200);
      await waitFor(() => fixture.fixture.recorded.input.length >= 2);
      record("green-http-raw-input", {
        status: 200,
        code: null,
        channelOpens: 2,
        inputs: 2,
      }, { status: result.response.status, code: null }, sideEffects(fixture.fixture));

      result = await postInput(httpDaemon.base, inputBody(harness, targetA, {
        machineId: "wrong-machine",
      }));
      assert.equal(result.response.status, 404);
      record("red-wrong-machine", {
        status: 404,
        code: "MEMBER_NOT_FOUND",
        channelOpens: 2,
        inputs: 2,
      }, {
        status: result.response.status,
        code: result.payload.error?.code ?? null,
      }, sideEffects(fixture.fixture));

      result = await postInput(httpDaemon.base, inputBody(harness, targetB));
      assert.equal(result.response.status, 424);
      record("red-unbound-target", {
        status: 424,
        code: "TERMINAL_TARGET_BINDING_UNAVAILABLE",
        channelOpens: 2,
        inputs: 2,
      }, {
        status: result.response.status,
        code: result.payload.error?.code ?? null,
      }, sideEffects(fixture.fixture));

      result = await postInput(httpDaemon.base, inputBody(harness, {
        backend: "tmux",
        stableId: "tmux:v1:not-in-catalog",
      }));
      assert.equal(result.response.status, 404);
      record("red-unknown-target", {
        status: 404,
        code: "TERMINAL_TARGET_IDENTITY_MISMATCH",
        channelOpens: 2,
        inputs: 2,
      }, {
        status: result.response.status,
        code: result.payload.error?.code ?? null,
      }, sideEffects(fixture.fixture));

      await harness.bindTarget(targetB);
      result = await postInput(httpDaemon.base, inputBody(harness, targetB, {
        expectedGeneration: harness.binding.generation - 1,
      }));
      assert.equal(result.response.status, 409);
      record("red-rebind-stale-generation", {
        status: 409,
        code: "BINDING_GENERATION_STALE",
        channelOpens: 2,
        inputs: 2,
      }, {
        status: result.response.status,
        code: result.payload.error?.code ?? null,
      }, sideEffects(fixture.fixture));
    } finally {
      await httpDaemon.close();
    }

    const wrongIdentityManager = createManager({ port: fixture.port, daemonHostId: "daemon-wrong" });
    const wrongIdentityAdmission = createAdmission(
      harness,
      createConnectionMachineTerminal({ connectionManager: wrongIdentityManager }),
    );
    let identityError = null;
    try {
      await wrongIdentityAdmission.forwardInput({
        callerToken: CALLER_TOKEN,
        workspaceId: harness.workspace.workspaceId,
        memberId: harness.member.memberId,
        machineId: MACHINE_ID,
        groupPath: harness.group.path,
        expectedGeneration: harness.binding.generation,
        target: targetB,
        data: "printf 'WRONG_IDENTITY'\\r",
      });
    } catch (error) {
      identityError = error;
    }
    assert.equal(identityError?.code, "peer_identity_mismatch");
    record("red-wrong-daemon-identity", {
      status: null,
      code: "peer_identity_mismatch",
        channelOpens: 2,
      inputs: 2,
    }, { status: null, code: identityError?.code ?? null }, sideEffects(fixture.fixture));
  } finally {
    await fixture.close();
  }
}

async function runRevokedLinkMatrix() {
  const fixture = await startFixture();
  try {
    const manager = createManager({ port: fixture.port });
    const catalog = await readCatalog(manager);
    const target = catalog.find((entry) => entry.name === fixture.names[0]);
    const harness = await createHarness(target);
    const admission = createAdmission(
      harness,
      createConnectionMachineTerminal({ connectionManager: manager }),
    );
    const admitted = await admission.admit({
      callerToken: CALLER_TOKEN,
      workspaceId: harness.workspace.workspaceId,
      memberId: harness.member.memberId,
      machineId: MACHINE_ID,
      groupPath: harness.group.path,
      expectedGeneration: harness.binding.generation,
      target,
    });
    assert.ok(admitted.terminal);
    fixture.fixture.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    let revokedError = null;
    try {
      await admission.forwardInput({
        callerToken: CALLER_TOKEN,
        workspaceId: harness.workspace.workspaceId,
        memberId: harness.member.memberId,
        machineId: MACHINE_ID,
        groupPath: harness.group.path,
        expectedGeneration: harness.binding.generation,
        target,
        data: "printf 'REVOKED'\\r",
      });
    } catch (error) {
      revokedError = error;
    }
    record("red-revoked-link", {
      status: null,
      code: "TERMINAL_TARGET_BINDING_UNAVAILABLE",
      channelOpens: 0,
      inputs: 0,
    }, { status: null, code: revokedError?.code ?? null }, sideEffects(fixture.fixture));
  } finally {
    try {
      await fixture.fixture.close();
    } catch {
      // The fixture was intentionally closed by the revoke case.
    }
    fixture.names && fixture.close();
  }
}

await runGreenAndHttpMatrix();
await runRevokedLinkMatrix();

const summary = {
  generatedAt: new Date().toISOString(),
  harness: "dev-auth + isolated tmux-backed simulated V1 mux fixture + real connections manager/V1TraversalTransport + real members/organization/routing services + daemon public HTTP (not real accounts, not real V1 daemon)",
  cases,
};
console.log(JSON.stringify(summary, null, 2));
process.exitCode = cases.every((entry) => entry.passed) ? 0 : 1;
