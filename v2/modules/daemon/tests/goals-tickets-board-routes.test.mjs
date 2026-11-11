import assert from "node:assert/strict";
import { test } from "node:test";

import { AccountsError } from "../../accounts/src/public/contracts.ts";
import { createDaemon } from "../src/server.mjs";

const TOKEN = "work-tracking-token";
const WORKSPACE_ID = "workspace-a";
const MANAGER_ID = "member-manager";

function fixture() {
  const calls = [];
  const account = {
    accountId: "account-manager",
    scopes: ["goals:read", "goals:write", "tickets:read", "tickets:write", "org:read"],
    workspaces: [WORKSPACE_ID],
  };
  const actor = {
    sessionId: "session-manager",
    accountId: "account-manager",
    memberId: MANAGER_ID,
    credentialState: "active",
  };
  const goals = {
    async listGoals(input) {
      calls.push(["goals.listGoals", input]);
      return [{ goalId: "goal-a", workspaceId: WORKSPACE_ID, name: "Goal A", ownerMemberId: MANAGER_ID, status: "active" }];
    },
    async createGoal(input) {
      calls.push(["goals.createGoal", input]);
      return { goalId: "goal-b", workspaceId: WORKSPACE_ID, name: input.name, ownerMemberId: input.ownerMemberId, status: input.status ?? "active" };
    },
  };
  const tickets = {
    async list(actorInput, input) {
      calls.push(["tickets.list", actorInput, input]);
      return {
        items: [{
          binding: { bindingId: "binding-1", workspaceId: WORKSPACE_ID, goalId: "goal-a", ownerMemberId: MANAGER_ID, category: "requirement", externalTaskId: 41, providerInstanceId: "vk-1" },
          ticket: { externalTaskId: 41, title: "Ticket A", priority: 3, done: false },
          providerObservedAt: 1,
          freshness: "fresh",
        }],
        observationStartedAt: 1,
        observationEndedAt: 2,
        freshness: "fresh",
      };
    },
    async authorizedTransitions() {
      return [];
    },
    async getInWorkspace(_actorInput, workspaceId, bindingId) {
      calls.push(["tickets.getInWorkspace", workspaceId, bindingId]);
      if (workspaceId !== WORKSPACE_ID) {
        throw Object.assign(new Error("binding is outside the path workspace"), {
          code: "TICKET_SCOPE_FORBIDDEN",
          owningModule: "tickets",
        });
      }
      return {
        binding: { bindingId, workspaceId, goalId: "goal-a", ownerMemberId: MANAGER_ID, category: "requirement", externalTaskId: 41, providerInstanceId: "vk-1" },
        ticket: { externalTaskId: 41, title: "Ticket A", priority: 3, done: false },
        providerObservedAt: 1,
        freshness: "fresh",
      };
    },
  };
  const board = {
    async queryManagerBoard(input) {
      calls.push(["board.queryManagerBoard", input]);
      return { workspaceId: input.workspaceId, managerId: input.managerId, observedAt: 3, goals: [], memberStatuses: [] };
    },
  };
  const workspaceAuth = { async verify(token) { assert.equal(token, TOKEN); return account; } };
  const resolveActor = async (input) => {
    assert.equal(input.account.accountId, account.accountId);
    return actor;
  };
  return { calls, goals, tickets, board, workspaceAuth, resolveActor };
}

async function start(t, fixtureValue) {
  const daemon = createDaemon({
    v2Token: TOKEN,
    log: () => {},
    workspaceAuth: fixtureValue.workspaceAuth,
    goals: fixtureValue.goals,
    tickets: fixtureValue.tickets,
    board: fixtureValue.board,
    resolveActor: fixtureValue.resolveActor,
  });
  await new Promise((resolve) => daemon.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return `http://127.0.0.1:${daemon.server.address().port}`;
}

async function request(base, path, options = {}) {
  return fetch(`${base}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${TOKEN}`, ...(options.headers ?? {}) },
  });
}

test("composed daemon exposes scoped goals, tickets, and board routes", async (t) => {
  const fixtureValue = fixture();
  const base = await start(t, fixtureValue);

  const goalsResponse = await request(base, `/api/workspaces/${WORKSPACE_ID}/goals`);
  assert.equal(goalsResponse.status, 200);
  assert.deepEqual(await goalsResponse.json(), {
    goals: [{ goalId: "goal-a", workspaceId: WORKSPACE_ID, name: "Goal A", ownerMemberId: MANAGER_ID, status: "active" }],
  });

  const ticketsResponse = await request(base, `/api/workspaces/${WORKSPACE_ID}/tickets?status=open`);
  assert.equal(ticketsResponse.status, 200);
  const ticketPayload = await ticketsResponse.json();
  assert.equal(ticketPayload.freshness, "fresh");
  assert.equal(ticketPayload.items[0].binding.bindingId, "binding-1");

  const boardResponse = await request(base, `/api/workspaces/${WORKSPACE_ID}/board?managerId=${MANAGER_ID}`);
  assert.equal(boardResponse.status, 200);
  assert.deepEqual(await boardResponse.json(), {
    workspaceId: WORKSPACE_ID,
    managerId: MANAGER_ID,
    observedAt: 3,
    goals: [],
    memberStatuses: [],
  });

  assert.ok(fixtureValue.calls.some(([name]) => name === "goals.listGoals"));
  assert.ok(fixtureValue.calls.some(([name]) => name === "tickets.list"));
  assert.ok(fixtureValue.calls.some(([name]) => name === "board.queryManagerBoard"));
});

test("goal create translates a title boundary without reading actor identity from the body", async (t) => {
  const fixtureValue = fixture();
  const base = await start(t, fixtureValue);

  const response = await request(base, `/api/workspaces/${WORKSPACE_ID}/goals`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "Goal B", ownerMemberId: MANAGER_ID, actorMemberId: "forged-member" }),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    goal: { goalId: "goal-b", workspaceId: WORKSPACE_ID, name: "Goal B", ownerMemberId: MANAGER_ID, status: "active" },
  });
  const call = fixtureValue.calls.find(([name]) => name === "goals.createGoal");
  assert.equal(call[1].actorMemberId, undefined);
});

test("work-tracking routes fail closed when composition or actor mapping is unavailable", async (t) => {
  const fixtureValue = fixture();
  const unconfigured = createDaemon({
    v2Token: TOKEN,
    log: () => {},
    workspaceAuth: fixtureValue.workspaceAuth,
  });
  await new Promise((resolve) => unconfigured.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => unconfigured.server.close(resolve)));
  const unconfiguredBase = `http://127.0.0.1:${unconfigured.server.address().port}`;
  const unconfiguredResponse = await request(unconfiguredBase, `/api/workspaces/${WORKSPACE_ID}/goals`);
  assert.equal(unconfiguredResponse.status, 503);
  assert.equal((await unconfiguredResponse.json()).error.code, "WORK_TRACKING_UNCONFIGURED");

  const missingActor = createDaemon({
    v2Token: TOKEN,
    log: () => {},
    workspaceAuth: fixtureValue.workspaceAuth,
    goals: fixtureValue.goals,
    tickets: fixtureValue.tickets,
    board: fixtureValue.board,
  });
  await new Promise((resolve) => missingActor.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => missingActor.server.close(resolve)));
  const missingActorBase = `http://127.0.0.1:${missingActor.server.address().port}`;
  const missingActorResponse = await request(missingActorBase, `/api/workspaces/${WORKSPACE_ID}/tickets`);
  assert.equal(missingActorResponse.status, 503);
  assert.equal((await missingActorResponse.json()).error.code, "WORK_TRACKING_ACTOR_UNCONFIGURED");
});

test("work-tracking scope rejection stays typed and cross-workspace binding paths are rejected", async (t) => {
  const fixtureValue = fixture();
  const denied = createDaemon({
    v2Token: TOKEN,
    log: () => {},
    workspaceAuth: fixtureValue.workspaceAuth,
    goals: fixtureValue.goals,
    tickets: fixtureValue.tickets,
    board: fixtureValue.board,
    resolveActor: async () => {
      throw Object.assign(new Error("actor is outside the workspace"), {
        code: "TICKET_SCOPE_FORBIDDEN",
        owningModule: "tickets",
        retryDisposition: "none",
      });
    },
  });
  await new Promise((resolve) => denied.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => denied.server.close(resolve)));
  const deniedBase = `http://127.0.0.1:${denied.server.address().port}`;
  const deniedResponse = await request(deniedBase, `/api/workspaces/${WORKSPACE_ID}/tickets`);
  assert.equal(deniedResponse.status, 403);
  const deniedPayload = await deniedResponse.json();
  assert.equal(deniedPayload.error.code, "TICKET_SCOPE_FORBIDDEN");
  assert.equal(deniedPayload.error.owningModule, "tickets");
  assert.equal(deniedPayload.error.retryDisposition, "none");

  const scoped = createDaemon({
    v2Token: TOKEN,
    log: () => {},
    workspaceAuth: fixtureValue.workspaceAuth,
    goals: fixtureValue.goals,
    tickets: fixtureValue.tickets,
    board: fixtureValue.board,
    resolveActor: fixtureValue.resolveActor,
  });
  await new Promise((resolve) => scoped.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => scoped.server.close(resolve)));
  const scopedBase = `http://127.0.0.1:${scoped.server.address().port}`;
  const crossWorkspaceResponse = await request(scopedBase, `/api/workspaces/workspace-b/tickets/binding-1`);
  assert.equal(crossWorkspaceResponse.status, 403);
  assert.equal((await crossWorkspaceResponse.json()).error.code, "TICKET_SCOPE_FORBIDDEN");
  assert.ok(fixtureValue.calls.some(([name, workspaceId, bindingId]) =>
    name === "tickets.getInWorkspace" && workspaceId === "workspace-b" && bindingId === "binding-1"
  ));
});

test("account identity denial stays typed and reaches no ticket provider operation", async (t) => {
  const fixtureValue = fixture();
  const denied = createDaemon({
    v2Token: TOKEN,
    log: () => {},
    workspaceAuth: fixtureValue.workspaceAuth,
    goals: fixtureValue.goals,
    tickets: fixtureValue.tickets,
    board: fixtureValue.board,
    resolveActor: async () => {
      throw new AccountsError(
        "ACCOUNT_MEMBER_IDENTITY_REQUIRED",
        403,
        "No explicit account/member identity binding exists for this workspace.",
      );
    },
  });
  await new Promise((resolve) => denied.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => denied.server.close(resolve)));
  const base = `http://127.0.0.1:${denied.server.address().port}`;

  const response = await request(base, `/api/workspaces/${WORKSPACE_ID}/tickets`);

  assert.equal(response.status, 403);
  const payload = await response.json();
  assert.equal(payload.error.code, "ACCOUNT_MEMBER_IDENTITY_REQUIRED");
  assert.equal(payload.error.owningModule, "accounts");
  assert.equal(fixtureValue.calls.some(([name]) => name === "tickets.list"), false);
});
