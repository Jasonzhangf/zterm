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

const TOKENS = Object.freeze({
  owner: "local-group-owner-token",
  denied: "local-group-denied-token",
});

const SCOPES = Object.freeze([
  "org:read",
  "org:write",
  "members:read",
  "members:write",
  ROUTE_RESOLVE_ACTION,
]);

function hostProbeDouble(overrides = {}) {
  let calls = 0;
  return Object.freeze({
    get calls() {
      return calls;
    },
    async probe() {
      calls += 1;
      return {
        available: true,
        machineId: "mac-1",
        sessionId: "$0",
        anchor: "%0",
        anchorPresent: true,
        terminalTarget: { backend: "tmux", stableId: "tmux:v1:observed" },
        observedAt: new Date().toISOString(),
        ...overrides,
      };
    },
  });
}

async function fixture({ hostProbe = hostProbeDouble(), withMembers = true, decorateMembers = null } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "zterm-local-group-"));
  const auth = createTrustedAuthDouble({
    accounts: {
      [TOKENS.owner]: { accountId: "acct-owner", scopes: SCOPES, workspaces: "*" },
      [TOKENS.denied]: {
        accountId: "acct-denied",
        scopes: ["members:read"],
        workspaces: ["ws-unrelated"],
        members: [],
      },
    },
  });
  const organization = createOrganizationService({
    store: createOrganizationStore(join(dir, "organization.json")),
    auth,
  });
  const baseMembers = withMembers
    ? createMembersService({
        store: createBindingStore(join(dir, "bindings.json")),
        auth,
        organization,
        hostProbe,
      })
    : null;
  const members = baseMembers && typeof decorateMembers === "function"
    ? decorateMembers(baseMembers)
    : baseMembers;
  const routing = createRoutingService({ organization, members, auth });

  const workspace = await organization.createWorkspace({ token: TOKENS.owner, name: "Acme" });
  const daemon = createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: "legacy-token",
    workspaceAuth: auth,
    organization,
    members,
    routing,
    memberHostObserver: {
      async observe({ runtime, binding }) {
        return {
          available: true,
          machineId: runtime.machineId,
          sessionId: binding.sessionId,
          anchor: binding.anchor,
          observedAt: "2026-11-11T00:00:00.000Z",
        };
      },
    },
    terminalPort: {
      async listSessions() {
        return [];
      },
      async subscribe() {
        throw new Error("terminal stream is not used by local group tests");
      },
      async input() {
        throw new Error("terminal input is not used by local group tests");
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
    workspace,
    organization,
    members,
    hostProbe,
  };
}

function headers(token = TOKENS.owner) {
  return { authorization: `Bearer ${token}` };
}

async function requestJson(base, path, { token = TOKENS.owner, method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...headers(token),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function setupWorkspace(app) {
  const group = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/groups`, {
    method: "POST",
    body: {
      name: "mac-a",
      parentGroupId: app.workspace.rootGroupId,
      expectedRevision: app.workspace.revision,
    },
  });
  const first = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members`, {
    method: "POST",
    body: {
      groupId: group.body.group.groupId,
      name: "Jenny",
      expectedRevision: group.body.group.revision,
    },
  });
  return { group: group.body.group, first: first.body.member };
}

test("local group configuration routes compose create, runtime, bind, restore, and extended projection", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const { group, first } = await setupWorkspace(app);

  const runtime = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/runtime`, {
    method: "POST",
    body: {
      machineId: "mac-1",
      hostKind: "tmux",
      agentKind: "codex",
      launchProfileRef: "lp-a",
    },
  });
  assert.equal(runtime.response.status, 200);
  assert.equal(runtime.body.runtime.memberId, first.memberId);

  const binding = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/binding`, {
    method: "POST",
    body: { sessionId: "$0", anchor: "%0", expectedGeneration: 0 },
  });
  assert.equal(binding.response.status, 200);
  assert.equal(binding.body.binding.generation, 1);
  assert.deepEqual(binding.body.binding.terminalTarget, { backend: "tmux", stableId: "tmux:v1:observed" });

  const projection = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/runtime`);
  assert.equal(projection.response.status, 200);
  assert.equal(projection.body.bindingGeneration, 1);
  assert.deepEqual(projection.body.agentCapabilities, { start: "unsupported", resume: "unsupported" });

  const restore = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/restore-binding`, {
    method: "POST",
    body: { machineId: "mac-1", expectedGeneration: 1 },
  });
  assert.equal(restore.response.status, 200);
  assert.equal(restore.body.verification.restored, true);
  assert.equal(restore.body.verification.generation, 1);
  assert.equal(group.groupId.length > 0, true);
});

test("member control projection consumes the atomic binding state", async (t) => {
  let separateBindingReads = 0;
  const atomicBinding = {
    memberId: "atomic-member",
    machineId: "mac-1",
    sessionId: "$atomic",
    anchor: "%atomic",
    generation: 9,
    terminalTarget: { backend: "tmux", stableId: "tmux:v1:atomic" },
  };
  const app = await fixture({
    decorateMembers(members) {
      return {
        ...members,
        async queryBindingState() {
          return { generation: atomicBinding.generation, binding: { ...atomicBinding } };
        },
        async queryBinding() {
          separateBindingReads += 1;
          return { ...atomicBinding, sessionId: "$separate", generation: 8 };
        },
      };
    },
  });
  t.after(() => app.close());
  const { first } = await setupWorkspace(app);
  await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/runtime`, {
    method: "POST",
    body: {
      machineId: "mac-1",
      hostKind: "tmux",
      agentKind: "codex",
      launchProfileRef: "lp-atomic",
    },
  });

  const projection = await requestJson(
    app.base,
    `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/runtime`,
  );

  assert.equal(projection.response.status, 200);
  assert.equal(projection.body.bindingGeneration, 9);
  assert.equal(projection.body.binding.sessionId, "$atomic");
  assert.equal(separateBindingReads, 0);
});

test("duplicate member name conflicts in one group and the same name is valid in another group", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const { group, first } = await setupWorkspace(app);

  const duplicate = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members`, {
    method: "POST",
    body: { groupId: group.groupId, name: first.name, expectedRevision: first.revision },
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, "MEMBER_NAME_CONFLICT");

  const secondGroup = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/groups`, {
    method: "POST",
    body: {
      name: "mac-b",
      parentGroupId: app.workspace.rootGroupId,
      expectedRevision: first.revision,
    },
  });
  assert.equal(secondGroup.response.status, 201);
  const sameName = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members`, {
    method: "POST",
    body: {
      groupId: secondGroup.body.group.groupId,
      name: first.name,
      expectedRevision: secondGroup.body.group.revision,
    },
  });
  assert.equal(sameName.response.status, 201);
  assert.notEqual(sameName.body.member.memberId, first.memberId);
});

test("denied credentials are rejected before members or host downstream calls", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const { first } = await setupWorkspace(app);
  const callsBefore = app.hostProbe.calls;

  const denied = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/runtime`, {
    token: TOKENS.denied,
  });
  assert.equal(denied.response.status, 403);
  assert.equal(app.hostProbe.calls, callsBefore);
});

test("malformed fields, stale revision, stale generation, and machine mismatch are typed", async (t) => {
  const app = await fixture();
  t.after(() => app.close());
  const { group, first } = await setupWorkspace(app);

  const badGroup = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/groups`, {
    method: "POST",
    body: { name: " ", parentGroupId: group.groupId, expectedRevision: 0 },
  });
  assert.equal(badGroup.response.status, 400);

  const staleRevision = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/groups`, {
    method: "POST",
    body: { name: "stale-revision", parentGroupId: group.groupId, expectedRevision: app.workspace.revision },
  });
  assert.equal(staleRevision.response.status, 409);
  assert.equal(staleRevision.body.error.code, "ORGANIZATION_REVISION_STALE");

  await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/runtime`, {
    method: "POST",
    body: { machineId: "mac-1", hostKind: "tmux", agentKind: "codex", launchProfileRef: "lp-a" },
  });
  const staleBind = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/binding`, {
    method: "POST",
    body: { sessionId: "$0", anchor: "%0", expectedGeneration: -1 },
  });
  assert.equal(staleBind.response.status, 400);

  await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/binding`, {
    method: "POST",
    body: { sessionId: "$0", anchor: "%0", expectedGeneration: 0 },
  });
  const staleRestore = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/restore-binding`, {
    method: "POST",
    body: { machineId: "mac-1", expectedGeneration: 0 },
  });
  assert.equal(staleRestore.response.status, 409);
  assert.equal(staleRestore.body.error.code, "BINDING_GENERATION_STALE");

  const mismatch = await requestJson(app.base, `/api/workspaces/${app.workspace.workspaceId}/members/${first.memberId}/restore-binding`, {
    method: "POST",
    body: { machineId: "mac-2", expectedGeneration: 1 },
  });
  assert.equal(mismatch.response.status, 409);
  assert.equal(mismatch.body.error.code, "BINDING_HOST_MISMATCH");
});

test("probe-free members composition refuses bind with a 503 before any downstream call", async (t) => {
  const appNoProbe = await fixture({ hostProbe: null, withMembers: true });
  t.after(() => appNoProbe.close());
  const noProbeGroup = await requestJson(appNoProbe.base, `/api/workspaces/${appNoProbe.workspace.workspaceId}/groups`, {
    method: "POST",
    body: { name: "no-probe", parentGroupId: appNoProbe.workspace.rootGroupId, expectedRevision: appNoProbe.workspace.revision },
  });
  const noProbeMember = await requestJson(appNoProbe.base, `/api/workspaces/${appNoProbe.workspace.workspaceId}/members`, {
    method: "POST",
    body: { groupId: noProbeGroup.body.group.groupId, name: "NoProbe", expectedRevision: noProbeGroup.body.group.revision },
  });
  await requestJson(appNoProbe.base, `/api/workspaces/${appNoProbe.workspace.workspaceId}/members/${noProbeMember.body.member.memberId}/runtime`, {
    method: "POST",
    body: { machineId: "mac-1", hostKind: "tmux", agentKind: "codex", launchProfileRef: "lp-a" },
  });
  const refused = await requestJson(appNoProbe.base, `/api/workspaces/${appNoProbe.workspace.workspaceId}/members/${noProbeMember.body.member.memberId}/binding`, {
    method: "POST",
    body: { sessionId: "$0", anchor: "%0", expectedGeneration: 0 },
  });
  assert.equal(refused.response.status, 503);
  assert.equal(refused.body.error.code, "CONTROL_HOST_PROBE_UNCONFIGURED");
});
