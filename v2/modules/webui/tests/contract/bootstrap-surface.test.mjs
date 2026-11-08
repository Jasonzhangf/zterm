import assert from "node:assert/strict";
import test from "node:test";
import { createDaemonApi, DaemonError } from "../../src/clients/daemon-api/index.mjs";
import {
  BOOTSTRAP_ROUTES,
  createBootstrapApp,
  parseBootstrapRoute,
  validateDaemonEndpoint,
} from "../../src/features/bootstrap/bootstrap-app.mjs";

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

function deferredResponse(status, body) {
  let resolve;
  const promise = new Promise((next) => {
    resolve = () => next(jsonResponse(status, body));
  });
  return { promise, resolve };
}

function createApp({ fetchImpl, storage = memoryStorage(), initialRoute = "setup" } = {}) {
  return createBootstrapApp({
    daemonApi: createDaemonApi({ fetchImpl }),
    storage,
    initialRoute,
  });
}

test("daemon-api login posts the account contract and accepts a verified account session", async () => {
  const { fetchImpl, calls } = recordedFetch([
    jsonResponse(200, {
      authenticated: true,
      account: { accountId: "acct-1", loginName: "alice" },
      csrf: "csrf-1",
    }),
  ]);
  const api = createDaemonApi({ baseUrl: "http://127.0.0.1:9999", fetchImpl });

  const payload = await api.login({ loginName: " alice ", credential: "secret" });

  assert.deepEqual(payload.account, { accountId: "acct-1", loginName: "alice" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/auth/login");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.deepEqual(calls[0].body, { loginName: " alice ", credential: "secret" });
});

test("daemon-api rejects legacy daemon-token success without a verified account session", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(200, { ok: true, csrfToken: "legacy-csrf", expiresAt: "2026-11-07T00:00:00.000Z" }),
  ]);
  const api = createDaemonApi({ baseUrl: "", fetchImpl });

  await assert.rejects(api.login({ loginName: "alice", credential: "secret" }), (error) => {
    assert.ok(error instanceof DaemonError);
    assert.equal(error.code, "ACCOUNT_SESSION_UNAVAILABLE");
    assert.equal(error.status, 501);
    return true;
  });
});

test("daemon-api sessionState requires the account view", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(200, { authenticated: true, configured: true, csrf: "legacy-csrf" }),
  ]);
  const api = createDaemonApi({ baseUrl: "", fetchImpl });

  await assert.rejects(api.sessionState(), (error) => {
    assert.equal(error.code, "ACCOUNT_SESSION_UNAVAILABLE");
    assert.equal(error.status, 501);
    return true;
  });
});

test("daemon-api workspace calls use the verified same-origin session and no bearer token", async () => {
  const root = { groupId: "g1", name: "root", members: [{ memberId: "m1", name: "mac" }] };
  const { fetchImpl, calls } = recordedFetch([
    jsonResponse(200, { workspaces: [{ workspaceId: "ws-1", name: "Primary" }] }),
    jsonResponse(200, { workspace: { workspaceId: "ws 1" }, root }),
  ]);
  const api = createDaemonApi({ baseUrl: "http://127.0.0.1:9999", fetchImpl });

  assert.deepEqual(await api.listWorkspaces(), [{ workspaceId: "ws-1", name: "Primary" }]);
  assert.deepEqual(await api.getWorkspaceTree({ workspaceId: "ws 1" }), root);

  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/workspaces");
  assert.equal(calls[1].url, "http://127.0.0.1:9999/api/workspaces/ws%201/tree");
  assert.equal(calls[0].options.credentials, "same-origin");
  assert.equal(calls[1].options.credentials, "same-origin");
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[1].options.headers, undefined);
});

test("bootstrap routes parse setup, login, and workspaces only", () => {
  assert.deepEqual(BOOTSTRAP_ROUTES, ["setup", "login", "workspaces"]);
  assert.equal(parseBootstrapRoute("#/setup"), "setup");
  assert.equal(parseBootstrapRoute("#/login"), "login");
  assert.equal(parseBootstrapRoute("#/workspaces"), "workspaces");
  assert.equal(parseBootstrapRoute("#/unknown"), "setup");
});

test("bootstrap endpoint validation binds requests to the WebUI origin", () => {
  assert.equal(
    validateDaemonEndpoint("http://127.0.0.1:9999/", { pageOrigin: "http://127.0.0.1:9999" }),
    "http://127.0.0.1:9999",
  );
  assert.throws(
    () => validateDaemonEndpoint("https://daemon.example.test", { pageOrigin: "http://127.0.0.1:9999" }),
    (error) => {
      assert.equal(error.code, "DAEMON_ENDPOINT_CROSS_ORIGIN_UNAVAILABLE");
      return true;
    },
  );
});

test("bootstrap setup stores only the daemon endpoint", () => {
  const storage = memoryStorage();
  const app = createApp({ fetchImpl: async () => jsonResponse(200, {}), storage });

  app.setDaemonEndpoint("http://127.0.0.1:9999/");

  assert.equal(app.state.endpoint, "http://127.0.0.1:9999");
  assert.deepEqual(storage.keys(), ["zterm.v2.daemonEndpoint"]);
});

test("bootstrap login requires loginName and credential before making a request", async () => {
  const { fetchImpl, calls } = recordedFetch([]);
  const app = createApp({ fetchImpl });

  const authenticated = await app.login({ loginName: "", credential: "secret" });

  assert.equal(authenticated, false);
  assert.equal(app.state.authError.code, "ACCOUNT_LOGIN_REQUIRED");
  assert.equal(calls.length, 0);
});

test("bootstrap login accepts a verified account session and keeps no credential in storage", async () => {
  const { fetchImpl, calls } = recordedFetch([
    jsonResponse(200, {
      authenticated: true,
      account: { accountId: "acct-1", loginName: "alice" },
      csrf: "csrf-1",
    }),
  ]);
  const storage = memoryStorage();
  const app = createApp({ fetchImpl, storage });
  app.setDaemonEndpoint("http://127.0.0.1:9999");

  const authenticated = await app.login({ loginName: "alice", credential: "secret" });

  assert.equal(authenticated, true);
  assert.equal(app.state.session.authenticated, true);
  assert.equal(app.state.session.account.loginName, "alice");
  assert.equal(app.state.session.csrf, "csrf-1");
  assert.equal(app.state.authError, null);
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/auth/login");
  assert.deepEqual(calls[0].body, { loginName: "alice", credential: "secret" });
  assert.equal(storage.keys().some((key) => storage.getItem(key).includes("secret")), false);
});

test("bootstrap login failure preserves the typed server error", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(401, { error: { code: "ACCOUNT_CREDENTIAL_INVALID", message: "Credential is invalid." } }),
  ]);
  const app = createApp({ fetchImpl });

  const authenticated = await app.login({ loginName: "alice", credential: "wrong" });

  assert.equal(authenticated, false);
  assert.equal(app.state.session.authenticated, false);
  assert.equal(app.state.authError.code, "ACCOUNT_CREDENTIAL_INVALID");
  assert.equal(app.state.authError.status, 401);
});

test("bootstrap logout failure keeps the verified session and exposes the typed error", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(200, { authenticated: true, account: { accountId: "acct-1" }, csrf: "csrf-1" }),
    jsonResponse(503, { error: { code: "ACCOUNT_REVOCATION_FAILED", message: "Relay revocation failed." } }),
  ]);
  const app = createApp({ fetchImpl });

  await app.login({ loginName: "alice", credential: "secret" });
  const result = await app.logout();

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "ACCOUNT_REVOCATION_FAILED");
  assert.equal(app.state.logoutError.code, "ACCOUNT_REVOCATION_FAILED");
  assert.equal(app.state.session.authenticated, true);
  assert.equal(app.state.route, "workspaces");
  assert.match(app.render(), /ACCOUNT_REVOCATION_FAILED/);
});

test("bootstrap logout success clears the verified session and workspace state", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(200, { authenticated: true, account: { accountId: "acct-1" }, csrf: "csrf-1" }),
    jsonResponse(200, { ok: true }),
  ]);
  const app = createApp({ fetchImpl });

  await app.login({ loginName: "alice", credential: "secret" });
  const result = await app.logout();

  assert.deepEqual(result, { ok: true });
  assert.equal(app.state.session.authenticated, false);
  assert.equal(app.state.route, "login");
  assert.equal(app.state.logoutError, null);
});

test("bootstrap workspace list discards a stale response", async () => {
  const first = deferredResponse(200, { workspaces: [{ workspaceId: "ws-old" }] });
  const second = deferredResponse(200, { workspaces: [{ workspaceId: "ws-new" }] });
  const calls = [];
  const app = createApp({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return calls.length === 1 ? first.promise : second.promise;
    },
  });
  app.setDaemonEndpoint("http://127.0.0.1:9999");

  const oldRequest = app.loadWorkspaces();
  const newRequest = app.loadWorkspaces();
  second.resolve();
  await newRequest;
  first.resolve();
  await oldRequest;

  assert.deepEqual(app.state.workspacesLoadable.value, [{ workspaceId: "ws-new" }]);
});

test("bootstrap endpoint switch invalidates a pending workspace load from the old endpoint", async () => {
  const pending = deferredResponse(200, { workspaces: [{ workspaceId: "ws-old-endpoint" }] });
  const calls = [];
  const app = createApp({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return pending.promise;
    },
  });
  app.setDaemonEndpoint("http://127.0.0.1:9999");

  const pendingRequest = app.loadWorkspaces();
  app.setDaemonEndpoint("http://127.0.0.1:9998");
  pending.resolve();
  await pendingRequest;

  assert.equal(app.state.endpoint, "http://127.0.0.1:9998");
  assert.equal(app.state.workspacesLoadable.status, "idle");
  assert.equal(app.state.workspacesLoadable.value, null);
});

test("bootstrap workspace tree discards a stale response and renders selection unavailable", async () => {
  const oldTree = deferredResponse(200, {
    root: { groupId: "old", members: [{ memberId: "m-old", name: "Old member" }] },
  });
  const newTree = deferredResponse(200, {
    root: { groupId: "new", members: [{ memberId: "m-new", name: "New member" }] },
  });
  const calls = [];
  const app = createApp({
    fetchImpl: async (url) => {
      calls.push(String(url));
      return calls.length === 1 ? oldTree.promise : newTree.promise;
    },
  });
  app.setDaemonEndpoint("http://127.0.0.1:9999");

  const oldRequest = app.selectWorkspace("ws-old");
  const newRequest = app.selectWorkspace("ws-new");
  newTree.resolve();
  await newRequest;
  oldTree.resolve();
  await oldRequest;

  assert.equal(app.state.selectedWorkspaceId, "ws-new");
  assert.deepEqual(app.state.memberCandidates, [{ memberId: "m-new", name: "New member" }]);
  assert.equal(app.state.machineSelection.available, false);
  assert.equal(app.state.machineSelection.reason.code, "MACHINE_SELECTION_UNAVAILABLE");
  const html = app.render();
  assert.match(html, /MACHINE_SELECTION_UNAVAILABLE/);
  assert.match(html, /New member/);
  assert.doesNotMatch(html, /Old member/);
  assert.doesNotMatch(html, /data-action="select-machine"/);
});

test("bootstrap restoreSession loads authorized workspaces for a verified account", async () => {
  const { fetchImpl, calls } = recordedFetch([
    jsonResponse(200, {
      authenticated: true,
      account: { accountId: "acct-1", loginName: "alice" },
      csrf: "csrf-1",
    }),
    jsonResponse(200, { workspaces: [{ workspaceId: "ws-1", name: "Primary" }] }),
  ]);
  const app = createApp({ fetchImpl, initialRoute: "setup" });
  app.setDaemonEndpoint("http://127.0.0.1:9999");

  await app.restoreSession();

  assert.equal(app.state.session.authenticated, true);
  assert.equal(app.state.route, "workspaces");
  assert.deepEqual(app.state.workspacesLoadable.value, [{ workspaceId: "ws-1", name: "Primary" }]);
  assert.equal(calls[0].url, "http://127.0.0.1:9999/api/auth/session");
  assert.equal(calls[1].url, "http://127.0.0.1:9999/api/workspaces");
});

test("bootstrap unauthorized workspace directory stays explicit", async () => {
  const { fetchImpl } = recordedFetch([
    jsonResponse(401, { error: { code: "AUTHENTICATION_REQUIRED", message: "Authentication is required." } }),
  ]);
  const app = createApp({ fetchImpl });

  await app.loadWorkspaces();

  assert.equal(app.state.workspacesLoadable.status, "error");
  assert.equal(app.state.workspacesLoadable.error.kind, "unauthorized");
  assert.equal(app.state.workspacesLoadable.error.code, "AUTHENTICATION_REQUIRED");
  assert.match(app.render(), /AUTHENTICATION_REQUIRED/);
});
