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
