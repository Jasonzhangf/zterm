import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonApi, DaemonError } from "../../src/clients/daemon-api/index.mjs";
import { BOOTSTRAP_ROUTES, createBootstrapApp, parseBootstrapRoute } from "../../src/features/bootstrap/bootstrap-app.mjs";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    keys() {
      return [...values.keys()];
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function recordedFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options, body: options.body ? JSON.parse(options.body) : null });
    const next = responses.shift();
    if (!next) {
      throw new TypeError("fetch failed");
    }
    return next;
  };
  return { fetchImpl, calls };
}

test("daemon-api login posts the daemon credential and keeps same-origin cookies", async () => {
  const { fetchImpl, calls } = recordedFetch([
    jsonResponse(200, { ok: true, csrfToken: "csrf-1", expiresAt: "2026-11-07T00:00:00.000Z" }),
  ]);
  const api = createDaemonApi({ baseUrl: "http://127.0.0.1:9999", fetchImpl });

  const payload = await api.login("daemon-token");

  assert.equal(payload.csrfToken, "csrf-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/auth/login");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(calls[0].body, { token: "daemon-token" });
});

test("daemon-api login failure preserves the typed daemon error and status", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(401, { error: { code: "V2_CREDENTIAL_INVALID", message: "V2 credential is invalid." } }),
  ]);
  const api = createDaemonApi({ baseUrl: "", fetchImpl });

  await assert.rejects(api.login("wrong"), (error) => {
    assert.ok(error instanceof DaemonError);
    assert.equal(error.code, "V2_CREDENTIAL_INVALID");
    assert.equal(error.status, 401);
    return true;
  });
});

test("daemon-api lists only server-authorized workspaces with the control-plane bearer token", async () => {
  const workspaces = [{ workspaceId: "ws-1", name: "Primary" }];
  const { fetchImpl, calls } = recordedFetch([jsonResponse(200, { workspaces })]);
  const api = createDaemonApi({ baseUrl: "http://127.0.0.1:9999", fetchImpl });

  const result = await api.listWorkspaces({ accountToken: "account-token" });

  assert.deepEqual(result, workspaces);
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/workspaces");
  assert.equal(calls[0].options.headers.authorization, "Bearer account-token");
});

test("daemon-api listWorkspaces rejects malformed workspace payloads", async () => {
  const { fetchImpl } = recordedFetch([jsonResponse(200, { workspaces: "nope" })]);
  const api = createDaemonApi({ baseUrl: "", fetchImpl });

  await assert.rejects(api.listWorkspaces(), (error) => {
    assert.equal(error.code, "WORKSPACES_RESPONSE_INVALID");
    assert.equal(error.status, 502);
    return true;
  });
});

test("daemon-api reads the server workspace tree with the control-plane bearer token", async () => {
  const root = { groupId: "g1", name: "root", members: [{ memberId: "m1", name: "mac" }] };
  const { fetchImpl, calls } = recordedFetch([jsonResponse(200, { workspace: { workspaceId: "ws 1" }, root })]);
  const api = createDaemonApi({ baseUrl: "http://127.0.0.1:9999", fetchImpl });

  const result = await api.getWorkspaceTree({ workspaceId: "ws 1", accountToken: "account-token" });

  assert.deepEqual(result, root);
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/workspaces/ws%201/tree");
  assert.equal(calls[0].options.headers.authorization, "Bearer account-token");
});

test("bootstrap routes parse setup, login, and workspaces only", () => {
  assert.deepEqual(BOOTSTRAP_ROUTES, ["setup", "login", "workspaces"]);
  assert.equal(parseBootstrapRoute("#/setup"), "setup");
  assert.equal(parseBootstrapRoute("#/login"), "login");
  assert.equal(parseBootstrapRoute("#/workspaces"), "workspaces");
  assert.equal(parseBootstrapRoute("#/unknown"), "setup");
});

test("bootstrap setup stores only the daemon endpoint, never credentials", () => {
  const storage = memoryStorage();
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl: async () => jsonResponse(200, {}) }), storage });

  app.setDaemonEndpoint("http://127.0.0.1:9999");
  app.setAccountWorkspaceToken("account-token");

  assert.equal(app.state.endpoint, "http://127.0.0.1:9999");
  assert.equal(storage.getItem("zterm.v2.daemonEndpoint"), "http://127.0.0.1:9999");
  assert.equal(storage.keys().includes("zterm.v2.daemonEndpoint"), true);
  assert.equal(storage.keys().some((key) => storage.getItem(key).includes("account-token")), false);
  assert.equal(app.state.accountWorkspaceToken, "account-token");
});

test("bootstrap setup rejects invalid daemon endpoints with a typed error", () => {
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl: async () => jsonResponse(200, {}) }), storage: memoryStorage() });

  assert.throws(() => app.setDaemonEndpoint("not-a-url"), (error) => {
    assert.equal(error.code, "DAEMON_ENDPOINT_INVALID");
    return true;
  });
});

test("bootstrap login success uses the daemon session and keeps no credential in storage", async () => {
  const { fetchImpl } = recordedFetch([jsonResponse(200, { ok: true, csrfToken: "csrf-1" })]);
  const storage = memoryStorage();
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl }), storage });

  await app.login({ credential: "daemon-token" });

  assert.equal(app.state.session.authenticated, true);
  assert.equal(app.state.session.csrf, "csrf-1");
  assert.equal(app.state.authError, null);
  assert.equal(storage.keys().some((key) => storage.getItem(key).includes("daemon-token")), false);
});

test("bootstrap login failure shows a typed error and never reports success", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(401, { error: { code: "V2_CREDENTIAL_INVALID", message: "V2 credential is invalid." } }),
  ]);
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl }), storage: memoryStorage() });

  await app.login({ credential: "wrong" });

  assert.equal(app.state.session.authenticated, false);
  assert.equal(app.state.authError.code, "V2_CREDENTIAL_INVALID");
  assert.equal(app.state.authError.status, 401);
});

test("bootstrap workspace directory renders only server-authorized workspaces", async () => {
  const workspaces = [{ workspaceId: "ws-1", name: "Primary" }];
  const { fetchImpl } = recordedFetch([jsonResponse(200, { workspaces })]);
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl }), storage: memoryStorage() });

  await app.loadWorkspaces();

  assert.equal(app.state.workspacesLoadable.status, "ready");
  assert.deepEqual(app.state.workspacesLoadable.value, workspaces);
  const html = app.render();
  assert.match(html, /Primary/);
});

test("bootstrap workspace directory keeps unauthorized lists explicit", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(401, { error: { code: "CONTROL_CREDENTIAL_REQUIRED", message: "A control-plane credential is required." } }),
  ]);
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl }), storage: memoryStorage() });

  await app.loadWorkspaces();

  assert.equal(app.state.workspacesLoadable.status, "error");
  assert.equal(app.state.workspacesLoadable.error.kind, "unauthorized");
  assert.equal(app.state.workspacesLoadable.error.code, "CONTROL_CREDENTIAL_REQUIRED");
  const html = app.render();
  assert.match(html, /CONTROL_CREDENTIAL_REQUIRED/);
});

test("bootstrap workspace directory keeps unavailable endpoints explicit", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(405, { error: { code: "METHOD_NOT_ALLOWED", message: "HTTP method is not allowed for this endpoint." } }),
  ]);
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl }), storage: memoryStorage() });

  await app.loadWorkspaces();

  assert.equal(app.state.workspacesLoadable.status, "unavailable");
  assert.equal(app.state.workspacesLoadable.error.kind, "unavailable");
  assert.equal(app.state.workspacesLoadable.error.code, "METHOD_NOT_ALLOWED");
  const html = app.render();
  assert.match(html, /METHOD_NOT_ALLOWED/);
});

test("bootstrap machine selection uses the server tree and enrollment stays disabled with a typed reason", async () => {
  const root = {
    groupId: "g1",
    name: "root",
    members: [
      { memberId: "m1", name: "MacBook" },
      { memberId: "m2", name: "Linux box" },
    ],
  };
  const { fetchImpl } = recordedFetch([jsonResponse(200, { root })]);
  const app = createBootstrapApp({ daemonApi: createDaemonApi({ fetchImpl }), storage: memoryStorage() });

  await app.selectWorkspace("ws-1");

  assert.deepEqual(app.state.machineCandidates, root.members);
  assert.equal(app.state.machineEnrollment.enabled, false);
  assert.equal(app.state.machineEnrollment.reason.code, "MACHINE_ENROLLMENT_UNAVAILABLE");
  const html = app.render();
  assert.match(html, /MACHINE_ENROLLMENT_UNAVAILABLE/);
});
