import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createDaemon } from "../src/server.mjs";
import { createTmuxHostProbe } from "../../host-adapters/src/public/index.mjs";
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

const TOKEN = "local-group-real-token";
const MACHINE_ID = "mac-real-1";

async function requestJson(base, path, { method = "GET", body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, body: await response.json() };
}

async function listen(daemon) {
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  return { daemon, base: `http://127.0.0.1:${port}` };
}

async function close(app) {
  await new Promise((resolve) => app.daemon.server.close(resolve));
}

test("owned daemon restart restores durable bindings and preserves typed recovery failures", async (t) => {
  const socketName = `zterm-local-group-recovery-${process.pid}`;
  const sessionA = `owned-a-${process.pid}`;
  const sessionB = `owned-b-${process.pid}`;
  const tmux = (...args) => execFileSync("tmux", ["-L", socketName, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const cleanup = [];

  t.after(async () => {
    for (const app of cleanup) {
      await close(app);
    }
    for (const sessionName of [sessionA, sessionB]) {
      try {
        tmux("has-session", "-t", sessionName);
        tmux("kill-session", "-t", sessionName);
      } catch {
        // The missing-session case may already have removed this exact session.
      }
    }
  });

  tmux("new-session", "-d", "-s", sessionA);
  tmux("new-session", "-d", "-s", sessionB);
  const paneA = tmux("display-message", "-p", "-t", sessionA, "#{pane_id}").trim();
  const paneB = tmux("display-message", "-p", "-t", sessionB, "#{pane_id}").trim();

  const root = await mkdtemp(join(tmpdir(), "zterm-local-group-real-"));
  const organizationFile = join(root, "organization.json");
  const bindingFile = join(root, "bindings.json");
  const auth = createTrustedAuthDouble({
    accounts: {
      [TOKEN]: {
        accountId: "acct-real",
        scopes: ["org:read", "org:write", "members:read", "members:write", ROUTE_RESOLVE_ACTION],
        workspaces: "*",
      },
    },
  });
  const organization = createOrganizationService({
    store: createOrganizationStore(organizationFile),
    auth,
  });
  const hostProbe = createTmuxHostProbe({ socketName, machineId: MACHINE_ID });
  const members = createMembersService({
    store: createBindingStore(bindingFile),
    auth,
    organization,
    hostProbe,
  });
  const routing = createRoutingService({ organization, members, auth });
  const workspace = await organization.createWorkspace({ token: TOKEN, name: "Recovery" });

  const firstDaemon = await listen(createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: "legacy-token",
    workspaceAuth: auth,
    organization,
    members,
    routing,
    terminalPort: {
      async listSessions() {
        return [];
      },
      async subscribe() {
        throw new Error("terminal stream is not used by real recovery tests");
      },
      async input() {
        throw new Error("terminal input is not used by real recovery tests");
      },
      close() {},
    },
  }));
  cleanup.push(firstDaemon);

  const groupA = await requestJson(firstDaemon.base, `/api/workspaces/${workspace.workspaceId}/groups`, {
    method: "POST",
    body: { name: "mac-a", parentGroupId: workspace.rootGroupId, expectedRevision: workspace.revision },
  });
  const groupB = await requestJson(firstDaemon.base, `/api/workspaces/${workspace.workspaceId}/groups`, {
    method: "POST",
    body: { name: "mac-b", parentGroupId: workspace.rootGroupId, expectedRevision: groupA.body.group.revision },
  });
  const memberA = await requestJson(firstDaemon.base, `/api/workspaces/${workspace.workspaceId}/members`, {
    method: "POST",
    body: { groupId: groupA.body.group.groupId, name: "Worker A", expectedRevision: groupB.body.group.revision },
  });
  const memberB = await requestJson(firstDaemon.base, `/api/workspaces/${workspace.workspaceId}/members`, {
    method: "POST",
    body: { groupId: groupB.body.group.groupId, name: "Worker B", expectedRevision: memberA.body.member.revision },
  });
  assert.equal(memberA.response.status, 201);
  assert.equal(memberB.response.status, 201);

  for (const member of [memberA.body.member, memberB.body.member]) {
    const configured = await requestJson(
      firstDaemon.base,
      `/api/workspaces/${workspace.workspaceId}/members/${member.memberId}/runtime`,
      {
        method: "POST",
        body: {
          machineId: MACHINE_ID,
          hostKind: "tmux",
          agentKind: "codex",
          launchProfileRef: "lp-real",
        },
      },
    );
    assert.equal(configured.response.status, 200);
  }

  const bindA = await requestJson(
    firstDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberA.body.member.memberId}/binding`,
    {
      method: "POST",
      body: { sessionId: sessionA, anchor: paneA, expectedGeneration: 0 },
    },
  );
  const bindB = await requestJson(
    firstDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberB.body.member.memberId}/binding`,
    {
      method: "POST",
      body: { sessionId: sessionB, anchor: paneB, expectedGeneration: 0 },
    },
  );
  assert.equal(bindA.response.status, 200);
  assert.equal(bindB.response.status, 200);
  assert.equal(bindA.body.binding.generation, 1);
  assert.equal(bindB.body.binding.generation, 1);

  await close(firstDaemon);

  const restartedMembers = createMembersService({
    store: createBindingStore(bindingFile),
    auth,
    organization,
    hostProbe,
  });
  const restartedRouting = createRoutingService({ organization, members: restartedMembers, auth });
  const secondDaemon = await listen(createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: "legacy-token",
    workspaceAuth: auth,
    organization,
    members: restartedMembers,
    routing: restartedRouting,
    terminalPort: {
      async listSessions() {
        return [];
      },
      async subscribe() {
        throw new Error("terminal stream is not used by real recovery tests");
      },
      async input() {
        throw new Error("terminal input is not used by real recovery tests");
      },
      close() {},
    },
  }));
  cleanup.push(secondDaemon);

  const restoredA = await requestJson(
    secondDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberA.body.member.memberId}/restore-binding`,
    {
      method: "POST",
      body: { machineId: MACHINE_ID, expectedGeneration: 1 },
    },
  );
  const restoredB = await requestJson(
    secondDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberB.body.member.memberId}/restore-binding`,
    {
      method: "POST",
      body: { machineId: MACHINE_ID, expectedGeneration: 1 },
    },
  );
  assert.equal(restoredA.response.status, 200);
  assert.equal(restoredB.response.status, 200);
  assert.equal(restoredA.body.verification.sessionId, sessionA);
  assert.equal(restoredB.body.verification.sessionId, sessionB);
  assert.equal(restoredA.body.verification.generation, 1);
  assert.equal(restoredB.body.verification.generation, 1);

  const reboundB = await requestJson(
    secondDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberB.body.member.memberId}/binding`,
    {
      method: "POST",
      body: { sessionId: sessionB, anchor: paneB, expectedGeneration: 1 },
    },
  );
  assert.equal(reboundB.response.status, 200);
  assert.equal(reboundB.body.binding.generation, 2);

  const staleRestoreB = await requestJson(
    secondDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberB.body.member.memberId}/restore-binding`,
    {
      method: "POST",
      body: { machineId: MACHINE_ID, expectedGeneration: 1 },
    },
  );
  assert.equal(staleRestoreB.response.status, 409);
  assert.equal(staleRestoreB.body.error.code, "BINDING_GENERATION_STALE");

  const wrongMachineProbe = createTmuxHostProbe({ socketName, machineId: "mac-other" });
  const wrongMachineMembers = createMembersService({
    store: createBindingStore(bindingFile),
    auth,
    organization,
    hostProbe: wrongMachineProbe,
  });
  const wrongMachineRouting = createRoutingService({ organization, members: wrongMachineMembers, auth });
  const wrongMachineDaemon = await listen(createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: "legacy-token",
    workspaceAuth: auth,
    organization,
    members: wrongMachineMembers,
    routing: wrongMachineRouting,
    terminalPort: {
      async listSessions() {
        return [];
      },
      async subscribe() {
        throw new Error("terminal stream is not used by real recovery tests");
      },
      async input() {
        throw new Error("terminal input is not used by real recovery tests");
      },
      close() {},
    },
  }));
  cleanup.push(wrongMachineDaemon);

  const machineMismatch = await requestJson(
    wrongMachineDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberB.body.member.memberId}/restore-binding`,
    {
      method: "POST",
      body: { machineId: MACHINE_ID, expectedGeneration: 2 },
    },
  );
  assert.equal(machineMismatch.response.status, 409);
  assert.equal(machineMismatch.body.error.code, "BINDING_HOST_MISMATCH");

  tmux("kill-session", "-t", sessionA);
  const missingSession = await requestJson(
    secondDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberA.body.member.memberId}/restore-binding`,
    {
      method: "POST",
      body: { machineId: MACHINE_ID, expectedGeneration: 1 },
    },
  );
  assert.equal(missingSession.response.status, 503);
  assert.equal(missingSession.body.error.code, "BINDING_HOST_UNAVAILABLE");

  const stillRestorableB = await requestJson(
    secondDaemon.base,
    `/api/workspaces/${workspace.workspaceId}/members/${memberB.body.member.memberId}/restore-binding`,
    {
      method: "POST",
      body: { machineId: MACHINE_ID, expectedGeneration: 2 },
    },
  );
  assert.equal(stillRestorableB.response.status, 200);
  assert.equal(stillRestorableB.body.verification.generation, 2);
});

