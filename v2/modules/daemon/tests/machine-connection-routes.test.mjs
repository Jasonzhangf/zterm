import assert from "node:assert/strict";
import { test } from "node:test";

import { TypedError } from "../../errors/src/public/index.mjs";
import { createDaemon } from "../src/server.mjs";

const V2_TOKEN = "machine-v2-token";
const MACHINE_ID = "machine-remote";
const OTHER_MACHINE_ID = "machine-other";

function typedError(code, owningModule, operationId, status) {
  const error = new TypedError({
    code,
    owningModule,
    operationId,
    message: `${code} from ${owningModule}`,
  });
  if (Number.isInteger(status)) {
    error.status = status;
  }
  return error;
}

function connectionError(code, message = code) {
  return Object.assign(new Error(message), {
    name: "ConnectionError",
    code,
    machineId: MACHINE_ID,
  });
}

function connectedObservation(machineId, generation, now) {
  return {
    machineId,
    generation,
    path: "direct",
    status: "connected",
    freshness: "fresh",
    observedAt: now,
    transportKind: "websocket",
    peerIdentity: "daemon-remote",
    peerIdentityVerified: true,
    capabilities: {
      channelKinds: ["terminal"],
      transportKind: "websocket",
    },
    backpressure: {
      queuedBytes: 0,
      bufferedBytes: 0,
      backpressured: false,
    },
  };
}

async function fixture(overrides = {}) {
  const calls = {
    listAuthorizedMachines: [],
    authorizeMachine: [],
    connect: [],
    observeLink: [],
    listSessions: [],
    closeOwnLink: [],
    terminal: [],
  };
  let activeLink = null;
  let generation = 0;
  let now = 1000;

  const machines = overrides.machines ?? [
    {
      machineId: MACHINE_ID,
      ownerAccountId: "account-current",
      displayName: "Remote Mac",
      status: "active",
      createdAt: "2026-11-11T00:00:00.000Z",
    },
    {
      machineId: OTHER_MACHINE_ID,
      ownerAccountId: "account-current",
      displayName: "Other Mac",
      status: "active",
      createdAt: "2026-11-11T00:00:00.000Z",
    },
  ];

  const machineService = {
    async listAuthorizedMachines(token) {
      calls.listAuthorizedMachines.push(token);
      if (overrides.listMachines) {
        return overrides.listMachines(token);
      }
      return machines;
    },
  };
  const machineAuthorization = {
    async authorizeMachine(machineId) {
      calls.authorizeMachine.push(machineId);
      if (overrides.authorizeMachine) {
        return overrides.authorizeMachine(machineId);
      }
      return {
        machineId,
        daemonHostId: "daemon-remote",
        accountId: "account-current",
        authorizationId: "authz-secret",
        capabilities: {
          channelKinds: ["terminal"],
          transportKind: "websocket",
        },
        target: {
          bridgeHost: "127.0.0.1",
          bridgePort: 49997,
          authToken: "bridge-secret",
          daemonHostId: "daemon-remote",
        },
        settings: {
          signalUrl: "ws://127.0.0.1:49998/signal",
        },
      };
    },
  };
  const connectionManager = {
    async connect(machineId, authorization) {
      calls.connect.push({ machineId, authorization });
      generation += 1;
      activeLink = { id: `link:${machineId}`, machineId, generation };
      return activeLink;
    },
    observeLink(link) {
      calls.observeLink.push(link);
      if (overrides.observeLink) {
        return overrides.observeLink(link);
      }
      if (!activeLink || activeLink.id !== link.id || activeLink.generation !== link.generation) {
        throw connectionError("stale_generation");
      }
      now += 1;
      return connectedObservation(link.machineId, link.generation, now);
    },
    async listSessions(link) {
      calls.listSessions.push(link);
      if (overrides.listSessions) {
        return overrides.listSessions(link);
      }
      if (!activeLink || activeLink.generation !== link.generation) {
        throw connectionError("stale_generation");
      }
      return [
        {
          name: "remote-shell",
          backend: "tmux",
          stableId: "stable-remote-shell",
        },
      ];
    },
    closeOwnLink(link) {
      calls.closeOwnLink.push(link);
      if (overrides.closeOwnLink) {
        return overrides.closeOwnLink(link);
      }
      if (activeLink?.generation === link.generation) {
        activeLink = null;
      }
    },
  };

  const daemon = createDaemon({
    v2Token: V2_TOKEN,
    machineService,
    machineAuthorization,
    connectionManager,
    terminalPort: {
      async listSessions() {
        calls.terminal.push("listSessions");
        return [];
      },
      async input() {
        calls.terminal.push("input");
        return {};
      },
      async subscribe() {
        calls.terminal.push("subscribe");
        return { close() {} };
      },
      async close() {
        calls.terminal.push("close");
      },
    },
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });

  return {
    base: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => daemon.server.close(resolve)),
  };
}

async function requestJson(base, path, { token = V2_TOKEN, method = "GET", body } = {}) {
  const headers = {};
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers["content-type"] = "application/json";
  }
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { response, body: await response.json() };
}

test("machines directory requires V2 authentication and forwards only the caller token", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const unauthorized = await requestJson(
    app.base,
    "/api/machines?accountId=account-attacker",
    { token: "wrong-token" },
  );
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.body.error.code, "V2_CREDENTIAL_INVALID");
  assert.equal(app.calls.listAuthorizedMachines.length, 0);

  const result = await requestJson(
    app.base,
    "/api/machines?accountId=account-attacker",
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(
    result.body.machines.map((machine) => machine.machineId),
    [MACHINE_ID, OTHER_MACHINE_ID],
  );
  assert.deepEqual(app.calls.listAuthorizedMachines, [V2_TOKEN]);
  assert.equal(app.calls.connect.length, 0);
});

test("connection before connect is explicitly unavailable and does not connect", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const result = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connection`,
  );
  assert.equal(result.response.status, 200);
  assert.equal(result.body.connection, null);
  assert.equal(result.body.status, "unavailable");
  assert.equal(result.body.observation.source, "connections");
  assert.equal(result.body.observation.value.status, "unavailable");
  assert.equal(result.body.observation.value.freshness, "unavailable");
  assert.equal(app.calls.connect.length, 0);
  assert.equal(app.calls.observeLink.length, 0);
});

test("connect authorizes, stores a non-secret link observation, and repeated connect advances generation", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const first = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connect`,
    {
      method: "POST",
      body: { accountId: "account-attacker" },
    },
  );
  assert.equal(first.response.status, 200);
  assert.equal(first.body.connection.machineId, MACHINE_ID);
  assert.equal(first.body.connection.status, "connected");
  assert.equal(first.body.connection.freshness, "fresh");
  assert.equal(first.body.connection.generation, 1);
  assert.equal(first.body.connection.peerIdentityVerified, true);
  assert.equal(first.body.connection.authToken, undefined);
  assert.equal(first.body.connection.bridgeHost, undefined);
  assert.equal(first.body.connection.signalUrl, undefined);
  assert.equal(first.body.connection.authorizationId, undefined);
  assert.deepEqual(app.calls.authorizeMachine, [MACHINE_ID]);
  assert.equal(app.calls.connect[0].authorization.authorizationId, "authz-secret");

  const second = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connect`,
    { method: "POST" },
  );
  assert.equal(second.response.status, 200);
  assert.equal(second.body.connection.generation, 2);
  assert.deepEqual(app.calls.authorizeMachine, [MACHINE_ID, MACHINE_ID]);
  assert.equal(app.calls.connect.length, 2);
});

test("stored connection observation is read-only and recover creates a new generation", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  await requestJson(app.base, `/api/machines/${MACHINE_ID}/connect`, { method: "POST" });
  const connected = await requestJson(app.base, `/api/machines/${MACHINE_ID}/connection`);
  assert.equal(connected.response.status, 200);
  assert.equal(connected.body.connection.generation, 1);
  assert.equal(connected.body.status, "connected");
  assert.equal(app.calls.connect.length, 1);

  const recovered = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/recover`,
    { method: "POST" },
  );
  assert.equal(recovered.response.status, 200);
  assert.equal(recovered.body.connection.generation, 2);
  assert.deepEqual(app.calls.authorizeMachine, [MACHINE_ID, MACHINE_ID]);

  const current = await requestJson(app.base, `/api/machines/${MACHINE_ID}/connection`);
  assert.equal(current.body.connection.generation, 2);
});

test("sessions require a current link, reauthorize, and never connect implicitly", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  const unavailable = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/sessions`,
  );
  assert.equal(unavailable.response.status, 409);
  assert.equal(unavailable.body.error.code, "MACHINE_NOT_CONNECTED");
  assert.equal(app.calls.authorizeMachine.length, 0);
  assert.equal(app.calls.listSessions.length, 0);
  assert.equal(app.calls.connect.length, 0);

  await requestJson(app.base, `/api/machines/${MACHINE_ID}/connect`, { method: "POST" });
  const result = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/sessions`,
  );
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.body.sessions, [
    {
      name: "remote-shell",
      backend: "tmux",
      stableId: "stable-remote-shell",
    },
  ]);
  assert.equal(result.body.observation.value.machineId, MACHINE_ID);
  assert.equal(result.body.observation.value.generation, 1);
  assert.deepEqual(app.calls.authorizeMachine, [MACHINE_ID, MACHINE_ID]);
  assert.equal(app.calls.connect.length, 1);
  assert.equal(app.calls.listSessions.length, 1);
  assert.equal(app.calls.listSessions[0].generation, 1);
});

test("disconnect closes only its machine link and removes the current observation", async (t) => {
  const app = await fixture();
  t.after(() => app.close());

  await requestJson(app.base, `/api/machines/${MACHINE_ID}/connect`, { method: "POST" });
  await requestJson(app.base, `/api/machines/${OTHER_MACHINE_ID}/connect`, { method: "POST" });

  const disconnected = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/disconnect`,
    { method: "POST" },
  );
  assert.equal(disconnected.response.status, 200);
  assert.equal(disconnected.body.disconnected, true);
  assert.equal(disconnected.body.status, "unavailable");
  assert.equal(app.calls.closeOwnLink.length, 1);
  assert.equal(app.calls.closeOwnLink[0].machineId, MACHINE_ID);

  const unavailable = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connection`,
  );
  assert.equal(unavailable.response.status, 200);
  assert.equal(unavailable.body.connection, null);

  const catalogUnavailable = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/sessions`,
  );
  assert.equal(catalogUnavailable.response.status, 409);
  assert.equal(catalogUnavailable.body.error.code, "MACHINE_NOT_CONNECTED");

  const inputUnavailable = await requestJson(
    app.base,
    "/api/terminal/input",
    {
      method: "POST",
      body: {
        machineId: MACHINE_ID,
        data: "echo should-not-send",
      },
    },
  );
  assert.equal(inputUnavailable.response.status, 503);
  assert.equal(inputUnavailable.body.error.code, "TERMINAL_ADMISSION_REQUIRED");

  const other = await requestJson(
    app.base,
    `/api/machines/${OTHER_MACHINE_ID}/connection`,
  );
  assert.equal(other.response.status, 200);
  assert.equal(other.body.connection.machineId, OTHER_MACHINE_ID);
  assert.equal(other.body.connection.generation, 2);
});

test("typed authorization and catalog failures keep owner, code, and operation", async (t) => {
  const app = await fixture({
    authorizeMachine(machineId) {
      if (machineId === "missing-route") {
        throw typedError(
          "MACHINE_NOT_FOUND",
          "accounts",
          "machine.authorize",
          404,
        );
      }
      if (machineId === "revoked") {
        throw typedError(
          "MACHINE_REVOKED",
          "accounts",
          "machine.authorize",
          403,
        );
      }
      return {
        machineId,
        daemonHostId: "daemon-remote",
        accountId: "account-current",
        authorizationId: "authz-secret",
        capabilities: {
          channelKinds: ["terminal"],
          transportKind: "websocket",
        },
        target: {
          bridgeHost: "127.0.0.1",
          bridgePort: 49997,
          daemonHostId: "daemon-remote",
        },
        settings: {},
      };
    },
    async listSessions() {
      throw connectionError("unknown", "catalog read failed");
    },
  });
  t.after(() => app.close());

  const missing = await requestJson(
    app.base,
    "/api/machines/missing-route/connect",
    { method: "POST" },
  );
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, "MACHINE_NOT_FOUND");
  assert.equal(missing.body.error.owningModule, "accounts");
  assert.equal(missing.body.error.operationId, "machine.authorize");

  const revoked = await requestJson(
    app.base,
    "/api/machines/revoked/connect",
    { method: "POST" },
  );
  assert.equal(revoked.response.status, 403);
  assert.equal(revoked.body.error.code, "MACHINE_REVOKED");
  assert.equal(revoked.body.error.owningModule, "accounts");

  await requestJson(app.base, `/api/machines/${MACHINE_ID}/connect`, { method: "POST" });
  const catalog = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/sessions`,
  );
  assert.equal(catalog.response.status, 502);
  assert.equal(catalog.body.error.code, "unknown");
  assert.equal(catalog.body.error.owningModule, "connections");
  assert.equal(catalog.body.error.operationId, "machine.sessions");
  assert.equal(app.calls.connect.length, 1);
});
