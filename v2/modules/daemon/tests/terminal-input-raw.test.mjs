import assert from "node:assert/strict";
import { test } from "node:test";
import { createDaemon } from "../src/server.mjs";
import { TypedError } from "../../errors/src/public/index.mjs";

const V2_TOKEN = "raw-input-v2-token";
const ACCOUNTS_TOKEN = "raw-input-accounts-token";
const MACHINE_ID = "machine-raw";
const DAEMON_HOST_ID = "daemon-raw";
const TARGET = Object.freeze({ backend: "tmux", stableId: "s1", name: "s1" });
const authHeaders = {
  authorization: `Bearer ${V2_TOKEN}`,
  "x-zterm-accounts-session": ACCOUNTS_TOKEN,
  "content-type": "application/json",
};

function createAdmissionHarness() {
  const inputs = [];
  const terminal = {
    inputs,
    async input(target, data) {
      inputs.push({ target, data });
      return { accepted: true };
    },
    async listSessions() {
      return [TARGET];
    },
    async close() {},
  };

  const auth = {
    async verify(token) {
      if (token !== ACCOUNTS_TOKEN) {
        throw new TypedError({
          code: "UNAUTHENTICATED",
          owningModule: "routing",
          operationId: "auth.verify",
          message: "The caller is not authenticated.",
        });
      }
      return { accountId: "account-raw" };
    },
  };
  const members = {
    async getRuntimeBinding(memberId) {
      return {
        memberId,
        machineId: MACHINE_ID,
        bindingGeneration: 0,
        sessionId: "session-raw",
        anchor: "pane:0",
        terminalTarget: { backend: TARGET.backend, stableId: TARGET.stableId },
      };
    },
    async resolveBindingTarget({ binding, catalog }) {
      return catalog.find((entry) => (
        entry.backend === binding.terminalTarget.backend
        && entry.stableId === binding.terminalTarget.stableId
      )) ?? null;
    },
  };
  const routing = {
    async resolve({ address }) {
      return {
        workspaceId: address.workspaceId,
        memberId: address.memberId,
        machineId: address.machineId,
        groupPath: address.groupPath,
      };
    },
  };
  const machineTerminalCalls = [];
  const machineTerminal = {
    async forMachine({ machineId, memberId, bindingGeneration, accountsToken }) {
      machineTerminalCalls.push({ machineId, memberId, bindingGeneration, accountsToken });
      if (accountsToken !== ACCOUNTS_TOKEN) {
        throw new TypedError({
          code: "MACHINE_ACCOUNT_SESSION_REQUIRED",
          owningModule: "accounts",
          operationId: "machine-terminal.forMachine",
          message: "The machine terminal authorization is not caller bound.",
        });
      }
      return {
        machineId,
        memberId,
        bindingGeneration,
        accountsToken,
        status: "connected",
        freshness: "fresh",
        peerIdentityVerified: true,
        daemonHostId: DAEMON_HOST_ID,
        linkGeneration: 0,
        listSessions: () => terminal.listSessions(),
        input: (target, data) => terminal.input(target, data),
        subscribe: () => ({ close() {} }),
      };
    },
  };
  machineTerminal.calls = machineTerminalCalls;

  return {
    admission: { auth, members, routing, machineTerminal },
    machineTerminal,
    inputs,
    terminalPort: terminal,
  };
}

async function startDaemon(t, harness) {
  const daemon = createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: V2_TOKEN,
    terminalPort: harness.terminalPort,
    admission: harness.admission,
    log: () => {},
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

function admissionBody(overrides = {}) {
  return {
    workspaceId: "ws-raw",
    memberId: "member-raw",
    machineId: MACHINE_ID,
    groupPath: "/raw",
    expectedGeneration: 0,
    target: { backend: TARGET.backend, stableId: TARGET.stableId },
    data: "l",
    ...overrides,
  };
}

function postInput(base, body, headers = authHeaders) {
  return fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

test("admitted raw input preserves exact bytes and does not add an Enter", async (t) => {
  const harness = createAdmissionHarness();
  const base = await startDaemon(t, harness);

  const cases = [
    ["l", "l"],
    ["l\r", "l\r"],
    ["中文", "中文"],
    ["\u0003\u001b[A", "\u0003\u001b[A"],
    ["\r", "\r"],
  ];
  for (const [data, expected] of cases) {
    const response = await postInput(base, admissionBody({ data, raw: true }));
    assert.equal(response.status, 200);
    assert.deepEqual(harness.inputs.at(-1), { target: TARGET.stableId, data: expected });
  }
});

test("terminal input keeps V2 gate and accounts session credentials separate", async (t) => {
  const harness = createAdmissionHarness();
  const base = await startDaemon(t, harness);

  const missingAccountsSession = await postInput(
    base,
    admissionBody({ data: "missing", raw: true }),
    {
      authorization: `Bearer ${V2_TOKEN}`,
      "content-type": "application/json",
    },
  );
  assert.equal(missingAccountsSession.status, 401);
  assert.equal(
    (await missingAccountsSession.json()).error.code,
    "MACHINE_ACCOUNT_SESSION_REQUIRED",
  );
  assert.equal(harness.inputs.length, 0);
  assert.equal(harness.machineTerminal.calls.length, 0);

  const v2Only = await postInput(
    base,
    admissionBody({ data: "v2-only", raw: true }),
    {
      authorization: `Bearer ${V2_TOKEN}`,
      "x-zterm-accounts-session": V2_TOKEN,
      "content-type": "application/json",
    },
  );
  assert.equal(v2Only.status, 401);
  assert.equal(harness.inputs.length, 0);
  assert.equal(harness.machineTerminal.calls.length, 0);

  const response = await postInput(base, admissionBody({ data: "l", raw: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(
    harness.machineTerminal.calls.map((call) => call.accountsToken),
    [ACCOUNTS_TOKEN, ACCOUNTS_TOKEN],
  );
});

test("legacy raw flag values do not change admitted byte forwarding", async (t) => {
  const harness = createAdmissionHarness();
  const base = await startDaemon(t, harness);

  for (const raw of [undefined, false, "true", 1]) {
    const body = admissionBody({ data: "l" });
    if (raw !== undefined) {
      body.raw = raw;
    }
    const response = await postInput(base, body);
    assert.equal(response.status, 200);
    assert.deepEqual(harness.inputs.at(-1), { target: TARGET.stableId, data: "l" });
  }
});

test("missing or non-string data is rejected before reaching terminal.input", async (t) => {
  const harness = createAdmissionHarness();
  const base = await startDaemon(t, harness);
  const before = harness.inputs.length;

  for (const data of [undefined, 7, null]) {
    const response = await postInput(base, admissionBody({ data }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INPUT_INVALID");
  }

  assert.equal(harness.inputs.length, before, "invalid input must not reach terminal.input");
});

test("invalid admitted input produces a typed 400 and no terminal side effect", async (t) => {
  const harness = createAdmissionHarness();
  const base = await startDaemon(t, harness);

  const response = await postInput(base, admissionBody({ data: "", raw: true }));

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "INPUT_INVALID");
  assert.equal(payload.accepted, undefined, "a rejected input must not produce an accepted receipt");
  assert.deepEqual(harness.inputs, [], "empty input must be rejected before terminal.input");
});

test("admitted input preserves delivery order and cannot bypass auth or target checks", async (t) => {
  const harness = createAdmissionHarness();
  const base = await startDaemon(t, harness);

  let response = await postInput(base, admissionBody({ data: "first", raw: true }));
  assert.equal(response.status, 200);
  response = await postInput(base, admissionBody({ data: "second", raw: true }));
  assert.equal(response.status, 200);
  assert.deepEqual(harness.inputs, [
    { target: TARGET.stableId, data: "first" },
    { target: TARGET.stableId, data: "second" },
  ]);

  response = await postInput(base, admissionBody({
    target: { backend: TARGET.backend, stableId: "missing" },
    data: "l",
    raw: true,
  }));
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "TERMINAL_TARGET_IDENTITY_MISMATCH");

  response = await postInput(
    base,
    admissionBody({ data: "l", raw: true }),
    { "content-type": "application/json" },
  );
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "V2_CREDENTIAL_REQUIRED");
});
