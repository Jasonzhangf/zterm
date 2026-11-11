import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDaemon } from "../src/server.mjs";
import {
  createOrganizationService,
  createOrganizationStore,
} from "../../organization/src/public/index.mjs";
import {
  createBindingStore,
  createMembersService,
} from "../../members/src/public/index.mjs";
import {
  ROUTE_RESOLVE_ACTION,
  createRoutingService,
} from "../../routing/src/public/index.mjs";
import { createTrustedAuthDouble } from "../../members/tests/support/trusted-auth-double.mjs";
import { TypedError } from "../../errors/src/public/index.mjs";

const TOKENS = Object.freeze({
  owner: "control-owner-token",
  other: "control-other-token",
  membersOnly: "control-members-only-token",
});

const SCOPES = Object.freeze([
  "org:read",
  "org:write",
  "members:read",
  "members:write",
  ROUTE_RESOLVE_ACTION,
]);

async function fixture({ hostObserver = null, terminalCatalog = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zterm-control-plane-"));
  const auth = createTrustedAuthDouble({
    accounts: {
      [TOKENS.owner]: { accountId: "acct-owner", scopes: SCOPES, workspaces: "*" },
      [TOKENS.other]: { accountId: "acct-other", scopes: SCOPES, workspaces: ["ws-other-account-only"] },
      [TOKENS.membersOnly]: { accountId: "acct-members-only", scopes: ["members:read"], workspaces: "*" },
    },
  });
  const organization = createOrganizationService({
    store: createOrganizationStore(join(dir, "organization.json")),
    auth,
  });
  const members = createMembersService({
    store: createBindingStore(join(dir, "bindings.json")),
    auth,
    organization,
  });
  const routing = createRoutingService({ organization, members, auth });

  const workspace = await organization.createWorkspace({ token: TOKENS.owner, name: "Acme" });
  const machineAEcosystem = await organization.createGroup({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    name: "mac-a",
    expectedRevision: workspace.revision,
  });
  const machineBEcosystem = await organization.createGroup({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    name: "mac-b",
    expectedRevision: machineAEcosystem.revision,
  });

  const first = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    groupId: machineAEcosystem.groupId,
    name: "Jenny",
    expectedRevision: machineBEcosystem.revision,
  });
  const second = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    groupId: machineBEcosystem.groupId,
    name: "Henry",
    expectedRevision: first.revision,
  });
  const unbound = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    groupId: machineBEcosystem.groupId,
    name: "Unbound",
    expectedRevision: second.revision,
  });
  const pendingBinding = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: workspace.workspaceId,
    groupId: machineAEcosystem.groupId,
    name: "PendingBinding",
    expectedRevision: unbound.revision,
  });

  const secondWorkspace = await organization.createWorkspace({ token: TOKENS.owner, name: "Other" });
  const otherWorkspaceMember = await organization.addMember({
    token: TOKENS.owner,
    workspaceId: secondWorkspace.workspaceId,
    groupId: secondWorkspace.rootGroupId,
    name: "SameMachineOtherWorkspace",
    expectedRevision: secondWorkspace.revision,
  });

  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: first.memberId,
    machineId: "mac-a",
    hostKind: "tmux",
    agentKind: "codex",
    launchProfileRef: "lp-a",
  });
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: second.memberId,
    machineId: "mac-b",
    hostKind: "tmux",
    agentKind: "claude",
    launchProfileRef: "lp-b",
  });
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: pendingBinding.memberId,
    machineId: "mac-a",
    hostKind: "tmux",
    agentKind: "codex",
    launchProfileRef: "lp-pending",
  });
  await members.configureRuntime({
    token: TOKENS.owner,
    memberId: otherWorkspaceMember.memberId,
    machineId: "mac-a",
    hostKind: "tmux",
    agentKind: "codex",
    launchProfileRef: "lp-other-workspace",
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: otherWorkspaceMember.memberId,
    sessionId: "session-other",
    anchor: "pane:9",
    expectedGeneration: 0,
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: first.memberId,
    sessionId: "session-old",
    anchor: "pane:0",
    expectedGeneration: 0,
  });
  await members.bindSession({
    token: TOKENS.owner,
    memberId: second.memberId,
    sessionId: "session-b",
    anchor: "pane:1",
    expectedGeneration: 0,
  });

  const daemon = createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: "legacy-token",
    workspaceAuth: auth,
    organization,
    members,
    routing,
    memberHostObserver: hostObserver ?? {
      async observe({ runtime, binding }) {
        return {
          available: true,
          machineId: runtime.machineId,
          sessionId: binding.sessionId,
          anchor: binding.anchor,
          observedAt: "2026-11-06T00:00:00.000Z",
        };
      },
    },
    terminalCatalog,
    terminalPort: {
      async listSessions() {
        return [];
      },
      async subscribe() {
        throw new Error("terminal stream is not used by control-plane tests");
      },
      async input() {
        throw new Error("terminal input is not used by control-plane tests");
      },
      close() {},
    },
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => daemon.server.close(resolve)),
    organization,
    members,
    workspace,
    secondWorkspace,
    first,
    second,
    unbound,
    pendingBinding,
    otherWorkspaceMember,
  };
}

function headers(token = TOKENS.owner) {
  return { authorization: `Bearer ${token}` };
}

async function requestJson(base, path, token) {
  const response = await fetch(`${base}${path}`, { headers: headers(token) });
  return { response, body: await response.json() };
}

test("workspace catalog returns only authorized stable references", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const { response, body } = await requestJson(app.base, "/api/workspaces");
  assert.equal(response.status, 200);
  assert.deepEqual(
    body.workspaces.map((workspace) => workspace.workspaceId),
    [app.workspace.workspaceId, app.secondWorkspace.workspaceId],
  );

  const other = await requestJson(app.base, "/api/workspaces", TOKENS.other);
  assert.equal(other.response.status, 200);
  assert.deepEqual(other.body.workspaces, []);
});

test("control-plane rejects cross-origin reads and invalid credentials explicitly", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const invalid = await requestJson(app.base, "/api/workspaces", "unknown-token");
  assert.equal(invalid.response.status, 401);
  assert.equal(invalid.body.error.code, "UNAUTHENTICATED");
  assert.equal(invalid.body.error.owningModule, "accounts");

  const crossOrigin = await fetch(`${app.base}/api/workspaces`, {
    headers: { ...headers(), origin: "https://evil.example" },
  });
  assert.equal(crossOrigin.status, 403);
  assert.equal((await crossOrigin.json()).error.code, "ORIGIN_NOT_ALLOWED");
});

test("the same machine can serve multiple workspaces without leaking members across them", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const firstTree = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/tree`);
  assert.equal(firstTree.response.status, 200);
  const firstMembers = flattenMembers(firstTree.body.root);
  assert.equal(firstMembers.some((member) => member.memberId === app.otherWorkspaceMember.memberId), false);
  assert.equal(firstMembers.find((member) => member.memberId === app.first.memberId).runtime.machineId, "mac-a");

  const secondTree = await requestJson(app.base, `/api/workspaces/${app.secondWorkspace.workspaceId}/tree`);
  assert.equal(secondTree.response.status, 200);
  const secondMembers = flattenMembers(secondTree.body.root);
  assert.deepEqual(secondMembers.map((member) => member.memberId), [app.otherWorkspaceMember.memberId]);
  assert.equal(secondMembers[0].runtime.machineId, "mac-a");
});

test("member identity stays stable when the bound session is replaced", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const first = await requestJson(
    app.base,
    `/api/workspaces/${app.workspace.workspaceId}/members/${app.first.memberId}/runtime`,
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.body.member.memberId, app.first.memberId);
  assert.equal(first.body.member.groupPath, "/Acme/mac-a");
  assert.equal(first.body.binding.sessionId, "session-old");
  assert.equal(first.body.binding.generation, 1);

  await app.members.bindSession({
    token: TOKENS.owner,
    memberId: app.first.memberId,
    sessionId: "session-new",
    anchor: "pane:7",
    expectedGeneration: 1,
  });

  const second = await requestJson(
    app.base,
    `/api/workspaces/${app.workspace.workspaceId}/members/${app.first.memberId}/runtime`,
  );
  assert.equal(second.response.status, 200);
  assert.equal(second.body.member.memberId, app.first.memberId);
  assert.equal(second.body.binding.sessionId, "session-new");
  assert.equal(second.body.binding.generation, 2);
});

test("one workspace returns co-located and cross-machine members with truthful unavailable state", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const tree = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/tree`);
  assert.equal(tree.response.status, 200);
  const members = flattenMembers(tree.body.root);
  assert.deepEqual(
    members.map((member) => member.memberId).sort(),
    [app.first.memberId, app.second.memberId, app.unbound.memberId, app.pendingBinding.memberId].sort(),
  );
  const byId = new Map(members.map((member) => [member.memberId, member]));
  assert.equal(members.length, 4);
  assert.equal(byId.get(app.first.memberId).runtime.machineId, "mac-a");
  assert.equal(byId.get(app.second.memberId).runtime.machineId, "mac-b");
  assert.equal(byId.get(app.unbound.memberId).availability.status, "unavailable");
  assert.equal(byId.get(app.unbound.memberId).availability.reason, "binding_not_found");
  assert.equal(byId.get(app.unbound.memberId).availability.unbound, true);
  assert.equal(byId.get(app.pendingBinding.memberId).runtime.machineId, "mac-a");
  assert.equal(byId.get(app.pendingBinding.memberId).availability.status, "unavailable");
  assert.equal(byId.get(app.pendingBinding.memberId).availability.reason, "binding_not_found");
  assert.equal(byId.get(app.first.memberId).availability.status, "bound");
  assert.equal(byId.get(app.first.memberId).availability.observedAt, "2026-11-06T00:00:00.000Z");
});

test("unassigned terminal catalog targets are reported and never become members", async (t) => {
  const app = await fixture({
    terminalCatalog: {
      async listSessions() {
        return [{ id: "external-session", name: "stray-tmux-session" }];
      },
    },
  });
  t.after(() => app.close());

  const tree = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/tree`);
  assert.equal(tree.response.status, 200);
  const members = flattenMembers(tree.body.root);
  assert.equal(members.some((member) => member.memberId === "stray-tmux-session"), false);
  assert.deepEqual(tree.body.observation.value.unassignedTerminalTargets, ["stray-tmux-session"]);
});

test("missing terminal catalog observation stays explicitly unknown", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const tree = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/tree`);
  assert.equal(tree.response.status, 200);
  assert.equal(tree.body.observation.value.unassignedTerminalTargets, null);
  assert.deepEqual(tree.body.observation.value.terminalCatalog, {
    status: "unknown",
    reason: "terminal_catalog_unconfigured",
  });
});

test("host observation failure yields typed unavailable instead of a constant online status", async (t) => {
  const app = await fixture({
    hostObserver: {
      async observe({ memberId }) {
        return {
          available: false,
          reason: "host_unreachable",
          memberId,
          machineId: "mac-a",
          observedAt: "2026-11-06T00:01:00.000Z",
        };
      },
    },
  });
  t.after(() => app.close());

  const tree = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/tree`);
  assert.equal(tree.response.status, 200);
  const first = flattenMembers(tree.body.root).find((member) => member.memberId === app.first.memberId);
  assert.equal(first.availability.status, "unavailable");
  assert.equal(first.availability.reason, "host_unreachable");
  assert.equal(first.availability.observedAt, "2026-11-06T00:01:00.000Z");
});

test("unauthorized workspace read is rejected before returning organization data", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const { response, body } = await requestJson(
    app.base,
    `/api/workspaces/${app.workspace.workspaceId}/tree`,
    TOKENS.other,
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, "ORGANIZATION_FORBIDDEN");
  assert.equal(body.error.owningModule, "organization");
});

test("direct member runtime requires organization authorization in addition to members authorization", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const membersView = await app.members.queryRuntime({
    token: TOKENS.membersOnly,
    memberId: app.first.memberId,
  });
  assert.equal(membersView.memberId, app.first.memberId);

  const { response, body } = await requestJson(
    app.base,
    `/api/workspaces/${app.workspace.workspaceId}/members/${app.first.memberId}/runtime`,
    TOKENS.membersOnly,
  );
  assert.equal(response.status, 403);
  assert.equal(body.error.code, "ORGANIZATION_FORBIDDEN");
  assert.equal(body.error.owningModule, "organization");
});

test("terminal catalog failure keeps the authorized tree readable and preserves the typed error", async (t) => {
  const app = await fixture({
    terminalCatalog: {
      async listSessions() {
        const error = new TypedError({
          code: "TERMINAL_CATALOG_UNAVAILABLE",
          owningModule: "terminal",
          operationId: "terminal.catalog.list",
          message: "The terminal catalog is unavailable.",
          cause: "isolated test failure",
        });
        error.retryDisposition = "retryable";
        throw error;
      },
    },
  });
  t.after(() => app.close());

  const { response, body } = await requestJson(
    app.base,
    `/api/workspaces/${app.workspace.workspaceId}/tree`,
  );
  assert.equal(response.status, 200);
  const members = flattenMembers(body.root);
  assert.deepEqual(
    members.map((member) => member.memberId).sort(),
    [app.first.memberId, app.second.memberId, app.unbound.memberId, app.pendingBinding.memberId].sort(),
  );
  assert.equal(
    members.some((member) => member.memberId === "stray-tmux-session"),
    false,
  );
  assert.equal(body.observation.value.unassignedTerminalTargets, null);
  assert.deepEqual(body.observation.value.terminalCatalog, {
    status: "unknown",
    reason: "terminal_catalog_unavailable",
    error: {
      code: "TERMINAL_CATALOG_UNAVAILABLE",
      owningModule: "terminal",
      operationId: "terminal.catalog.list",
      cause: "isolated test failure",
      message: "The terminal catalog is unavailable.",
      retryDisposition: "retryable",
      details: null,
    },
  });
});

test("resolve returns the stable member and exact binding generation over HTTP", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const response = await fetch(`${app.base}/api/workspaces/${app.workspace.workspaceId}/resolve`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      machineId: "mac-a",
      groupPath: "/Acme/mac-a",
      memberId: app.first.memberId,
      expectedGeneration: 1,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resolved.memberId, app.first.memberId);
  assert.equal(body.resolved.bindingGeneration, 1);
  assert.equal(body.resolved.sessionId, "session-old");
  assert.equal(body.resolved.anchor, "pane:0");

  const stale = await fetch(`${app.base}/api/workspaces/${app.workspace.workspaceId}/resolve`, {
    method: "POST",
    headers: { ...headers(), "content-type": "application/json" },
    body: JSON.stringify({
      machineId: "mac-a",
      groupPath: "/Acme/mac-a",
      memberId: app.first.memberId,
      expectedGeneration: 9,
    }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, "BINDING_GENERATION_STALE");
});

function flattenMembers(node, result = []) {
  if (!node) return result;
  result.push(...(node.members ?? []));
  for (const child of node.children ?? []) {
    flattenMembers(child, result);
  }
  return result;
}
