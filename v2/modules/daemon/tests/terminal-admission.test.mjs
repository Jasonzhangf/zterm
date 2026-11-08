import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDaemon } from "../src/server.mjs";
import { startDaemon as startDaemonEntry } from "../src/main.mjs";
import { createV1MuxFixture } from "../../terminal/tests/v1-mux-fixture.mjs";
import { TerminalPort } from "../../terminal/src/public/index.mjs";
import {
  createOrganizationService,
  createOrganizationStore,
} from "../../organization/src/public/index.mjs";
import {
  createBindingStore,
  createMembersService,
} from "../../members/src/public/index.mjs";
import {
  createRoutingDevAuth,
  createRoutingService,
} from "../../routing/src/public/index.mjs";

const SEED_TOKEN = "admission-seed-token";
const CALLER_TOKEN = "admission-caller-token";
const OTHER_WORKSPACE_TOKEN = "admission-other-workspace-token";
const V1_TOKEN = "admission-v1-token";
const MACHINE_ID = "mac-admission";
const DAEMON_HOST_ID = "daemon-admission";
const ROOT = "/tmp/zterm-admission";

let sequence = 0;

function tmux(socket, args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function startTerminal(t) {
  sequence += 1;
  const id = `${process.pid}-${sequence}`;
  const socket = `${ROOT}/${id}.sock`;
  const session = `admission-${id}`;
  execFileSync("mkdir", ["-p", ROOT]);
  tmux(socket, ["new-session", "-d", "-s", session, "-x", "90", "-y", "24"]);
  t.after(() => {
    try {
      tmux(socket, ["kill-session", "-t", session]);
    } catch {
      // The dedicated session is already gone.
    }
  });
  return { socket, session };
}

async function startTerminalPair(t) {
  sequence += 1;
  const id = `${process.pid}-${sequence}`;
  const socket = `${ROOT}/${id}.sock`;
  const first = `admission-${id}-a`;
  const second = `admission-${id}-b`;
  execFileSync("mkdir", ["-p", ROOT]);
  tmux(socket, ["new-session", "-d", "-s", first, "-x", "90", "-y", "24"]);
  tmux(socket, ["new-session", "-d", "-s", second, "-x", "90", "-y", "24"]);
  t.after(() => {
    for (const session of [first, second]) {
      try {
        tmux(socket, ["kill-session", "-t", session]);
      } catch {
        // The dedicated session is already gone.
      }
    }
  });
  return { socket, first, second };
}

async function startFixture(t, socket) {
  const fixture = createV1MuxFixture({ tmuxSocket: socket, authToken: V1_TOKEN });
  const { port } = await fixture.listen();
  t.after(() => fixture.close());
  return { fixture, port };
}

function createMachineTerminal(t, { v1Port, state = {} } = {}) {
  const terminal = new TerminalPort({
    wsUrl: `ws://127.0.0.1:${v1Port}/ws?token=${encodeURIComponent(V1_TOKEN)}`,
    log: () => {},
  });
  const link = {
    machineId: MACHINE_ID,
    status: "connected",
    freshness: "fresh",
    peerIdentityVerified: true,
    daemonHostId: DAEMON_HOST_ID,
    linkGeneration: 0,
    calls: 0,
    ...state,
  };
  t.after(() => terminal.close());
  return {
    link,
    async forMachine(request) {
      link.calls += 1;
      await link.beforeReturn?.({ request, link, call: link.calls });
      if (link.failure) {
        throw link.failure;
      }
      return {
        machineId: link.machineId,
        status: link.status,
        freshness: link.freshness,
        peerIdentityVerified: link.peerIdentityVerified,
        daemonHostId: link.daemonHostId,
        linkGeneration: link.linkGeneration,
        listSessions: () => terminal.listSessions(),
        input: (target, data) => terminal.input(target, data),
        subscribe: (target, listener, options) => terminal.subscribe(target, listener, options),
      };
    },
  };
}

async function createAdmissionHarness({ bind = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zterm-daemon-admission-"));
  const seedAuth = createRoutingDevAuth({
    accounts: {
      [SEED_TOKEN]: {
        accountId: "acct-seed",
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

  const workspace = await organization.createWorkspace({ token: SEED_TOKEN, name: "Admission" });
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
    launchProfileRef: "lp-admission",
  });
  let binding = null;
  if (bind) {
    binding = await members.bindSession({
      token: SEED_TOKEN,
      memberId: member.memberId,
      sessionId: "sess-admission",
      anchor: "pane:0",
      expectedGeneration: 0,
    });
  }

  const callerAuth = createRoutingDevAuth({
    accounts: {
      [CALLER_TOKEN]: {
        accountId: "acct-caller",
        scopes: ["routing:resolve"],
        workspaces: [workspace.workspaceId],
        members: [member.memberId],
      },
      [OTHER_WORKSPACE_TOKEN]: {
        accountId: "acct-other",
        scopes: ["routing:resolve"],
        workspaces: ["ws-other"],
      },
    },
  });
  const routing = createRoutingService({ organization, members, auth: callerAuth });

  return {
    dir,
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
    async bindTarget(target) {
      if (
        !target
        || typeof target.backend !== "string"
        || typeof target.stableId !== "string"
      ) {
        throw new TypeError("bindTarget requires a catalog entry with backend and stableId");
      }
      binding = await members.bindSession({
        token: SEED_TOKEN,
        memberId: member.memberId,
        sessionId: `binding-${member.memberId}-${binding ? binding.generation + 1 : 1}`,
        anchor: "pane:0",
        expectedGeneration: binding ? binding.generation : 0,
        terminalTarget: {
          backend: target.backend,
          stableId: target.stableId,
        },
      });
      return binding;
    },
  };
}

function admissionPorts(harness, { token = CALLER_TOKEN } = {}) {
  return {
    auth: harness.callerAuth,
    routing: harness.routing,
    members: harness.members,
    organization: harness.organization,
    token,
  };
}

async function startDaemon(t, { v1Port, admission, v2Token = CALLER_TOKEN } = {}) {
  let machineTerminal = null;
  let resolvedAdmission = admission;
  if (admission) {
    machineTerminal = admission.machineTerminal === undefined
      ? createMachineTerminal(t, { v1Port })
      : admission.machineTerminal;
    resolvedAdmission = { ...admission, machineTerminal };
  }
  const daemon = createDaemon({
    v1WsUrl: `ws://127.0.0.1:${v1Port}/ws?token=${encodeURIComponent(V1_TOKEN)}`,
    v1Token: V1_TOKEN,
    v2Token,
    admission: resolvedAdmission,
    log: () => {},
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return { daemon, base: `http://127.0.0.1:${port}`, machineTerminal };
}

async function exactCatalogTarget(daemon) {
  const sessions = await daemon.terminal.listSessions();
  const session = sessions[0];
  assert.ok(session, "the fixture must expose one tmux session");
  assert.equal(typeof session.stableId, "string");
  return { backend: session.backend, stableId: session.stableId, name: session.name };
}

async function startDaemonViaEntry(t, { v1Port, admission }) {
  let machineTerminal = null;
  let resolvedAdmission = admission;
  if (admission) {
    machineTerminal = admission.machineTerminal === undefined
      ? createMachineTerminal(t, { v1Port })
      : admission.machineTerminal;
    resolvedAdmission = { ...admission, machineTerminal };
  }
  const daemon = await startDaemonEntry({
    port: 0,
    host: "127.0.0.1",
    v1WsUrl: `ws://127.0.0.1:${v1Port}/ws?token=${encodeURIComponent(V1_TOKEN)}`,
    v1Token: V1_TOKEN,
    v2Token: CALLER_TOKEN,
    admission: resolvedAdmission,
    log: () => {},
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return {
    daemon,
    base: `http://127.0.0.1:${daemon.server.address().port}`,
    machineTerminal,
  };
}

function admissionBody(harness, target, overrides = {}) {
  return {
    workspaceId: harness.workspace.workspaceId,
    memberId: harness.member.memberId,
    machineId: MACHINE_ID,
    groupPath: harness.group.path,
    expectedGeneration: harness.binding ? harness.binding.generation : 0,
    target,
    data: "echo ADMISSION_MARKER",
    ...overrides,
  };
}

function postInput(base, body, token = CALLER_TOKEN) {
  return fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function errorCode(response) {
  return (await response.json()).error?.code;
}

function connectionError(code) {
  const error = new Error(`connection ${code}`);
  error.name = "ConnectionError";
  error.code = code;
  error.machineId = MACHINE_ID;
  return error;
}

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out waiting for a condition.");
}

function assertNoTerminalSideEffects(fixture) {
  assert.equal(fixture.recorded.channelOpen.length, 0, "refused admission must not open a channel");
  assert.equal(fixture.recorded.input.length, 0, "refused admission must not write input");
}

test("routing-configured daemon rejects a legacy terminal input that bypasses admission", async (t) => {
  const { socket, session } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });

  const response = await postInput(base, { target: session, data: "echo BYPASS" });
  assert.equal(response.status, 400);
  assert.ok(
    ["VALIDATION", "TERMINAL_TARGET_IDENTITY_REQUIRED"].includes(await errorCode(response)),
    "a legacy target string must not bypass the admission target identity",
  );
  assert.equal(fixture.recorded.input.length, 0, "no input may be forwarded without admission");
});

test("admission rejects missing and invalid credentials before target access", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);

  let response = await postInput(base, admissionBody(harness, target), "");
  assert.equal(response.status, 401);
  assert.equal(await errorCode(response), "UNAUTHENTICATED");

  response = await postInput(base, admissionBody(harness, target), "not-a-token");
  assert.equal(response.status, 401);
  assert.equal(await errorCode(response), "UNAUTHENTICATED");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects an unauthorized workspace", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);

  const response = await postInput(
    base,
    admissionBody(harness, target),
    OTHER_WORKSPACE_TOKEN,
  );
  assert.equal(response.status, 403);
  assert.equal(await errorCode(response), "ROUTE_FORBIDDEN");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects an unknown member", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);

  const response = await postInput(base, admissionBody(harness, target, {
    memberId: "mbr-missing",
  }));
  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "MEMBER_NOT_FOUND");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects an unbound member", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness({ bind: false });
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "MEMBER_BINDING_NOT_FOUND");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects a stale binding generation", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);

  const response = await postInput(base, admissionBody(harness, target, {
    expectedGeneration: 0,
  }));
  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), "BINDING_GENERATION_STALE");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects a missing or wrong terminal target identity", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  let response = await postInput(base, admissionBody(harness, {}));
  assert.equal(response.status, 400);
  assert.equal(await errorCode(response), "TERMINAL_TARGET_IDENTITY_REQUIRED");

  response = await postInput(base, admissionBody(harness, {
    backend: target.backend,
    stableId: "tmux:v1:not-the-catalog-session",
  }));
  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "TERMINAL_TARGET_IDENTITY_MISMATCH");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects an authorized member targeting an unrelated terminal", async (t) => {
  const { socket, first, second } = await startTerminalPair(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });

  const sessions = await daemon.terminal.listSessions();
  assert.equal(sessions.length, 2, "the fixture must expose the bound target and an unrelated target");
  const bound = sessions.find((candidate) => candidate.name === first);
  const unrelated = sessions.find((candidate) => candidate.name === second);
  assert.ok(bound && unrelated);
  await harness.bindTarget(bound);

  const response = await postInput(base, admissionBody(harness, {
    backend: unrelated.backend,
    stableId: unrelated.stableId,
  }));
  assert.equal(response.status, 424);
  assert.equal(await errorCode(response), "TERMINAL_TARGET_BINDING_UNAVAILABLE");
  assert.equal(fixture.recorded.channelOpen.length, 0, "an unrelated target must not be subscribed");
  assert.equal(fixture.recorded.input.length, 0, "an unrelated target must not receive input");
});

test("admission opens the exact existingOnly target and forwards typed input", async (t) => {
  const { socket, session } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target, {
    data: "echo ADMISSION_GREEN\r",
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accepted, true);
  assert.equal(payload.admission.memberId, harness.member.memberId);
  assert.equal(payload.admission.bindingGeneration, harness.binding.generation);
  assert.equal(payload.admission.backend, target.backend);
  assert.equal(payload.admission.stableId, target.stableId);

  assert.equal(fixture.recorded.channelOpen.length, 1);
  const opened = fixture.recorded.channelOpen[0].payload;
  assert.equal(opened.existingOnly, true);
  assert.equal(opened.expectedSessionIdentity, target.stableId);
  assert.equal(opened.backend, target.backend);
  assert.equal(opened.sessionName, session);

  assert.equal(fixture.recorded.input.length, 1);
  assert.equal(fixture.recorded.input[0].data, "echo ADMISSION_GREEN\r");
  await waitFor(() => tmux(socket, ["capture-pane", "-p", "-t", session]).includes("ADMISSION_GREEN"));
});

test("admission forwards nonempty raw input without appending an Enter", async (t) => {
  const { socket, session } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target, {
    data: "echo ADMISSION_WITHOUT_CR",
  }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accepted, true);
  assert.equal(fixture.recorded.input.length, 1);
  assert.equal(fixture.recorded.input[0].data, "echo ADMISSION_WITHOUT_CR");
  const captured = tmux(socket, ["capture-pane", "-p", "-t", session]);
  assert.ok(captured.includes("ADMISSION_WITHOUT_CR"), "the raw typed text must reach tmux");
});

test("admission forwards one Enter as exactly one CR", async (t) => {
  const { socket, session } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target, { data: "\r" }));
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.accepted, true);
  assert.equal(fixture.recorded.input.length, 1);
  assert.equal(fixture.recorded.input[0].data, "\r");
});

test("admission stream exposes the exact admitted session", async (t) => {
  const { socket, session } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base, machineTerminal } = await startDaemon(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);
  const query = new URLSearchParams({
    workspaceId: harness.workspace.workspaceId,
    memberId: harness.member.memberId,
    machineId: MACHINE_ID,
    groupPath: harness.group.path,
    expectedGeneration: String(harness.binding.generation),
    backend: target.backend,
    stableId: target.stableId,
  });

  const response = await fetch(`${base}/api/terminal/stream?${query.toString()}`, {
    headers: { authorization: `Bearer ${CALLER_TOKEN}` },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") || "", /text\/event-stream/u);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("event: ready")) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  assert.match(text, /event: ready/u);
  const readyData = text.split("\n").find((line) => line.startsWith("data: "));
  const ready = JSON.parse(readyData.slice("data: ".length));
  assert.equal(ready.target, session);
  assert.equal(ready.backend, target.backend);
  assert.equal(ready.stableId, target.stableId);
  assert.equal(ready.memberId, harness.member.memberId);
  assert.equal(ready.bindingGeneration, harness.binding.generation);

  const opened = fixture.recorded.channelOpen[0].payload;
  assert.equal(opened.existingOnly, true);
  assert.equal(opened.expectedSessionIdentity, target.stableId);
  assert.ok(machineTerminal.link.calls >= 2, "stream must recheck the machine link before subscribe");
  await reader.cancel();
});

test("startDaemon forwards admission to the public input route", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemonViaEntry(t, {
    v1Port,
    admission: admissionPorts(harness),
  });
  const target = await exactCatalogTarget(daemon);

  const response = await postInput(base, admissionBody(harness, target, {
    memberId: "mbr-missing",
  }));
  assert.equal(response.status, 404);
  assert.equal(await errorCode(response), "MEMBER_NOT_FOUND");
  assert.equal(fixture.recorded.input.length, 0);
});

test("admission rejects the same target text when the scoped consumer belongs to another machine", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const machineTerminal = createMachineTerminal(t, {
    v1Port,
    state: { machineId: "other-machine" },
  });
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), machineTerminal },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), "MEMBER_BINDING_INVALID");
  assertNoTerminalSideEffects(fixture);
});

test("admission rejects a revoked machine link before opening the target", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const machineTerminal = createMachineTerminal(t, {
    v1Port,
    state: { status: "revoked" },
  });
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), machineTerminal },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 424);
  assert.equal(await errorCode(response), "TERMINAL_TARGET_BINDING_UNAVAILABLE");
  assertNoTerminalSideEffects(fixture);
});

test("admission preserves a connections peer identity mismatch", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const machineTerminal = createMachineTerminal(t, {
    v1Port,
    state: { failure: connectionError("peer_identity_mismatch") },
  });
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), machineTerminal },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 401);
  assert.equal(await errorCode(response), "peer_identity_mismatch");
  assertNoTerminalSideEffects(fixture);
});

test("admission rejects a superseded link generation before dispatch", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const machineTerminal = createMachineTerminal(t, {
    v1Port,
    state: {
      linkGeneration: 1,
      beforeReturn({ link, call }) {
        if (call === 2) {
          link.linkGeneration = 2;
        }
      },
    },
  });
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), machineTerminal },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), "stale_generation");
  assertNoTerminalSideEffects(fixture);
});

test("admission rejects a rebind that lands between lookup and dispatch", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const machineTerminal = createMachineTerminal(t, { v1Port });
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), machineTerminal },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);
  machineTerminal.link.beforeReturn = async ({ call }) => {
    if (call === 1) {
      machineTerminal.link.beforeReturn = null;
      await harness.bindTarget(target);
    }
  };

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 409);
  assert.equal(await errorCode(response), "BINDING_GENERATION_STALE");
  assertNoTerminalSideEffects(fixture);
});

test("admission fails closed when the machine terminal consumer is absent", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), machineTerminal: null },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 424);
  assert.equal(await errorCode(response), "TERMINAL_TARGET_BINDING_UNAVAILABLE");
  assertNoTerminalSideEffects(fixture);
});

test("admission fails closed when members does not expose the public resolver", async (t) => {
  const { socket } = await startTerminal(t);
  const { fixture, port: v1Port } = await startFixture(t, socket);
  const harness = await createAdmissionHarness();
  const resolverlessMembers = {
    getRuntimeBinding: (memberId) => harness.members.getRuntimeBinding(memberId),
  };
  const { daemon, base } = await startDaemon(t, {
    v1Port,
    admission: { ...admissionPorts(harness), members: resolverlessMembers },
  });
  const target = await exactCatalogTarget(daemon);
  await harness.bindTarget(target);

  const response = await postInput(base, admissionBody(harness, target));
  assert.equal(response.status, 424);
  assert.equal(await errorCode(response), "TERMINAL_TARGET_BINDING_UNAVAILABLE");
  assertNoTerminalSideEffects(fixture);
});
