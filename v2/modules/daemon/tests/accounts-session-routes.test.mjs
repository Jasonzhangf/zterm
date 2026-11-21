import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AccountsError,
  AuthService,
} from "../../accounts/src/public/contracts.ts";
import { createDaemon } from "../src/server.mjs";

const V2_TOKEN = "accounts-session-v2-token";
const LOGIN_NAME = "alice";
const CREDENTIAL = "credential-secret";
const ACCOUNTS_TOKEN = "accounts-relay-token";
const MACHINE_ID = "machine-remote";

function authServiceFixture() {
  const sessions = new Map([
    [ACCOUNTS_TOKEN, {
      accessToken: ACCOUNTS_TOKEN,
      accountId: "acct-alice",
      loginName: LOGIN_NAME,
    }],
  ]);
  const authority = {
    async register() {
      throw new Error("register is not used");
    },
    async authenticate(loginName, credential) {
      if (loginName !== LOGIN_NAME || credential !== CREDENTIAL) {
        throw new AccountsError("INVALID_CREDENTIALS", 401);
      }
      return sessions.get(ACCOUNTS_TOKEN);
    },
    async validateSession(token) {
      const session = sessions.get(token);
      if (!session) {
        throw new AccountsError("AUTHENTICATION_REQUIRED", 401);
      }
      return session;
    },
    async logout(token) {
      sessions.delete(token);
    },
  };
  return new AuthService({ authority });
}

async function machineLogoutFixture(t, { closeError } = {}) {
  const state = {
    activeLink: null,
    closeCalls: [],
    connectCalls: 0,
    generation: 0,
    sessions: new Map(),
  };
  let loginSequence = 0;
  const authority = {
    async register() {
      throw new Error("register is not used");
    },
    async authenticate(loginName, credential) {
      if (loginName !== LOGIN_NAME || credential !== CREDENTIAL) {
        throw new AccountsError("INVALID_CREDENTIALS", 401);
      }
      loginSequence += 1;
      const session = {
        accessToken: `accounts-link-token-${loginSequence}`,
        accountId: "acct-alice",
        loginName: LOGIN_NAME,
      };
      state.sessions.set(session.accessToken, session);
      return session;
    },
    async validateSession(token) {
      const session = state.sessions.get(token);
      if (!session) {
        throw new AccountsError("AUTHENTICATION_REQUIRED", 401);
      }
      return session;
    },
    async logout(token) {
      state.sessions.delete(token);
    },
  };
  const connectionManager = {
    async connect(machineId, callerToken) {
      state.connectCalls += 1;
      state.generation += 1;
      const link = {
        id: `link:${state.generation}`,
        machineId,
        callerToken,
        generation: state.generation,
      };
      state.activeLink = link;
      return link;
    },
    observeLink(link) {
      if (state.activeLink !== link) {
        throw Object.assign(new Error("stale_generation"), {
          name: "ConnectionError",
          code: "stale_generation",
          machineId: link.machineId,
        });
      }
      return {
        machineId: link.machineId,
        generation: link.generation,
        path: "direct",
        status: "connected",
        freshness: "fresh",
      };
    },
    async listSessions() {
      return [];
    },
    closeOwnLink(link) {
      state.closeCalls.push(link);
      if (closeError) {
        throw closeError;
      }
      if (state.activeLink === link) {
        state.activeLink = null;
      }
    },
  };
  const authorization = (machineId, accountId) => ({ machineId, accountId });
  const machineAuthorization = {
    async authorizeCallerMachine(machineId, token) {
      const session = state.sessions.get(token);
      if (!session) {
        throw new AccountsError("AUTHENTICATION_REQUIRED", 401);
      }
      return authorization(machineId, session.accountId);
    },
    async authorizeMachine(machineId) {
      return authorization(machineId, "acct-alice");
    },
  };
  const daemon = createDaemon({
    v2Token: V2_TOKEN,
    authService: new AuthService({ authority }),
    machineAuthorization,
    connectionManager,
    log: () => {},
  });
  const base = await listen(t, daemon);
  return { base, state };
}

async function listen(t, daemon) {
  await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return `http://127.0.0.1:${daemon.server.address().port}`;
}

async function requestJson(base, path, {
  method = "GET",
  v2Token = V2_TOKEN,
  accountsToken = null,
  body,
} = {}) {
  const headers = {};
  if (v2Token !== null) {
    headers.authorization = `Bearer ${v2Token}`;
  }
  if (accountsToken !== null) {
    headers["x-zterm-accounts-session"] = accountsToken;
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

test("accounts login, session, and logout use the real accounts service behind the V2 gate", async (t) => {
  const logs = [];
  const daemon = createDaemon({
    v2Token: V2_TOKEN,
    authService: authServiceFixture(),
    log: (event) => logs.push(event),
  });
  const base = await listen(t, daemon);

  const loginWithoutV2 = await requestJson(base, "/api/accounts/login", {
    method: "POST",
    v2Token: null,
    body: { loginName: LOGIN_NAME, credential: CREDENTIAL },
  });
  assert.equal(loginWithoutV2.response.status, 401);
  assert.equal(loginWithoutV2.body.error.code, "V2_CREDENTIAL_REQUIRED");

  const login = await requestJson(base, "/api/accounts/login", {
    method: "POST",
    body: { loginName: LOGIN_NAME, credential: CREDENTIAL },
  });
  assert.equal(login.response.status, 200);
  assert.deepEqual(login.body, {
    token: ACCOUNTS_TOKEN,
    account: {
      accountId: "acct-alice",
      loginName: LOGIN_NAME,
    },
  });
  assert.equal(JSON.stringify(login.body).includes(CREDENTIAL), false);
  assert.equal(JSON.stringify(logs).includes(CREDENTIAL), false);
  assert.equal(JSON.stringify(logs).includes(ACCOUNTS_TOKEN), false);

  const session = await requestJson(base, "/api/accounts/session", {
    accountsToken: ACCOUNTS_TOKEN,
  });
  assert.equal(session.response.status, 200);
  assert.deepEqual(session.body, {
    account: {
      accountId: "acct-alice",
      loginName: LOGIN_NAME,
    },
  });

  const logout = await requestJson(base, "/api/accounts/logout", {
    method: "POST",
    accountsToken: ACCOUNTS_TOKEN,
  });
  assert.equal(logout.response.status, 200);
  assert.deepEqual(logout.body, { ok: true });

  const revoked = await requestJson(base, "/api/accounts/session", {
    accountsToken: ACCOUNTS_TOKEN,
  });
  assert.equal(revoked.response.status, 401);
  assert.equal(revoked.body.error.code, "AUTHENTICATION_REQUIRED");
});

test("accounts logout closes account-scoped machine links before a later session can reuse them", async (t) => {
  const app = await machineLogoutFixture(t);

  const firstLogin = await requestJson(app.base, "/api/accounts/login", {
    method: "POST",
    body: { loginName: LOGIN_NAME, credential: CREDENTIAL },
  });
  assert.equal(firstLogin.response.status, 200);
  const firstToken = firstLogin.body.token;

  const connected = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connect`,
    { method: "POST", accountsToken: firstToken },
  );
  assert.equal(connected.response.status, 200);
  assert.equal(app.state.activeLink?.id, "link:1");
  assert.equal(app.state.closeCalls.length, 0);

  const logout = await requestJson(app.base, "/api/accounts/logout", {
    method: "POST",
    accountsToken: firstToken,
  });
  assert.equal(logout.response.status, 200);
  assert.deepEqual(logout.body, { ok: true });
  assert.equal(app.state.closeCalls.length, 1);
  assert.equal(app.state.activeLink, null);

  const revoked = await requestJson(app.base, "/api/accounts/session", {
    accountsToken: firstToken,
  });
  assert.equal(revoked.response.status, 401);

  const secondLogin = await requestJson(app.base, "/api/accounts/login", {
    method: "POST",
    body: { loginName: LOGIN_NAME, credential: CREDENTIAL },
  });
  assert.equal(secondLogin.response.status, 200);
  const secondToken = secondLogin.body.token;
  assert.notEqual(secondToken, firstToken);

  const inherited = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connection`,
    { accountsToken: secondToken },
  );
  assert.equal(inherited.response.status, 200);
  assert.equal(inherited.body.connection, null);
  assert.equal(inherited.body.status, "unavailable");
  assert.equal(app.state.connectCalls, 1);

  const reconnected = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connect`,
    { method: "POST", accountsToken: secondToken },
  );
  assert.equal(reconnected.response.status, 200);
  assert.equal(reconnected.body.connection.status, "connected");
  assert.notEqual(
    reconnected.body.connection.generation,
    connected.body.connection.generation,
  );
  assert.equal(app.state.connectCalls, 2);
});

test("accounts logout preserves typed machine link cleanup errors and keeps the session active", async (t) => {
  const closeError = Object.assign(new Error("machine link close failed"), {
    name: "ConnectionError",
    code: "channel_close_failed",
    machineId: MACHINE_ID,
  });
  const app = await machineLogoutFixture(t, { closeError });

  const login = await requestJson(app.base, "/api/accounts/login", {
    method: "POST",
    body: { loginName: LOGIN_NAME, credential: CREDENTIAL },
  });
  const token = login.body.token;
  const connected = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connect`,
    { method: "POST", accountsToken: token },
  );
  assert.equal(connected.response.status, 200);

  const logout = await requestJson(app.base, "/api/accounts/logout", {
    method: "POST",
    accountsToken: token,
  });
  assert.equal(logout.response.status, 424);
  assert.equal(logout.body.error.code, "channel_close_failed");
  assert.equal(logout.body.error.owningModule, "connections");
  assert.equal(app.state.activeLink?.id, "link:1");

  const session = await requestJson(app.base, "/api/accounts/session", {
    accountsToken: token,
  });
  assert.equal(session.response.status, 200);

  const current = await requestJson(
    app.base,
    `/api/machines/${MACHINE_ID}/connection`,
    { accountsToken: token },
  );
  assert.equal(current.response.status, 200);
  assert.equal(current.body.connection.status, "connected");
});
