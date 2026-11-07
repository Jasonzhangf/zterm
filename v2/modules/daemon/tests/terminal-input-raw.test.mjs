import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalPort } from "../../terminal/src/terminal-port.mjs";
import { TypedError } from "../../errors/src/typed-error.mjs";
import { createDaemon } from "../src/server.mjs";

const TOKEN = "raw-input-token";
const authHeaders = { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" };

function fakeTerminal({ knownTargets = null } = {}) {
  const inputs = [];
  return {
    inputs,
    async input(target, data) {
      if (knownTargets && !knownTargets.has(target)) {
        throw new TypedError({
          code: "TARGET_NOT_FOUND",
          owningModule: "terminal",
          operationId: "input",
          cause: "The terminal target does not exist.",
          message: "Terminal target was not found.",
        });
      }
      inputs.push({ target, data });
      return { accepted: true };
    },
    async listSessions() {
      return [];
    },
    async close() {},
  };
}

async function startDaemon(t, terminalPort) {
  const daemon = createDaemon({
    v1WsUrl: "ws://127.0.0.1:1/ws",
    v2Token: TOKEN,
    terminalPort,
    log: () => {},
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return `http://127.0.0.1:${port}`;
}

function postInput(base, body, headers = authHeaders) {
  return fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

// Real TerminalPort with a guarded mux client. Its input() rejects a non-empty
// string requirement before resolveSession, so any transport call is a failure.
function guardedTerminalPort() {
  const calls = [];
  const fail = (name) => async () => {
    calls.push(name);
    throw new Error(`mux client must not be used for an invalid input: ${name}`);
  };
  const port = new TerminalPort({
    log: () => {},
    muxClient: {
      onClose: () => {},
      onChannelCloseFailure: () => {},
      connect: fail("connect"),
      requestTarget: fail("requestTarget"),
      openChannel: fail("openChannel"),
      subscribeChannel: fail("subscribeChannel"),
      sendChannelMessage: () => calls.push("sendChannelMessage"),
      close: () => {},
    },
  });
  return { port, calls };
}

test("raw input passes data through untouched while non-raw keeps the trailing return", async (t) => {
  const terminal = fakeTerminal();
  const base = await startDaemon(t, terminal);

  let response = await postInput(base, { target: "s1", data: "l", raw: true });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "l" });

  // Already terminated data must not gain a second return.
  response = await postInput(base, { target: "s1", data: "l\r", raw: true });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "l\r" });

  // Multibyte text and control sequences are the core raw-mode contract.
  response = await postInput(base, { target: "s1", data: "中文", raw: true });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "中文" });

  response = await postInput(base, { target: "s1", data: "\u0003\u001b[A", raw: true });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "\u0003\u001b[A" });

  response = await postInput(base, { target: "s1", data: "l" });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "l\r" });
});

test("raw is a strict boolean, so non-boolean values keep the legacy return append", async (t) => {
  const terminal = fakeTerminal();
  const base = await startDaemon(t, terminal);

  for (const raw of [undefined, false, "true", 1]) {
    const response = await postInput(base, raw === undefined ? { target: "s1", data: "l" } : { target: "s1", data: "l", raw });
    assert.equal(response.status, 200);
    assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "l\r" });
  }
});

test("missing or non-string data is rejected before reaching terminal.input", async (t) => {
  const terminal = fakeTerminal();
  const base = await startDaemon(t, terminal);

  // Non-raw empty input keeps the legacy behavior of sending one return.
  let response = await postInput(base, { target: "s1", data: "" });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs.at(-1), { target: "s1", data: "\r" });

  const before = terminal.inputs.length;
  for (const body of [{ target: "s1", raw: true }, { target: "s1", data: 7, raw: true }, { target: "s1", data: null, raw: true }]) {
    response = await postInput(base, body);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INPUT_INVALID");
  }
  assert.equal(terminal.inputs.length, before, "invalid input must not reach terminal.input");
});

test("real TerminalPort rejects an empty raw string with a typed 400 and no transport call", async (t) => {
  const { port, calls } = guardedTerminalPort();
  const base = await startDaemon(t, port);

  const response = await postInput(base, { target: "s1", data: "", raw: true });

  assert.equal(response.status, 400);
  const payload = await response.json();
  assert.equal(payload.error.code, "INPUT_INVALID");
  assert.equal(payload.accepted, undefined, "a rejected input must not produce an accepted receipt");
  assert.deepEqual(calls, [], "empty input must be rejected before resolve/attach/send");
});

test("raw input preserves delivery order and cannot bypass auth or target checks", async (t) => {
  const terminal = fakeTerminal({ knownTargets: new Set(["s1"]) });
  const base = await startDaemon(t, terminal);

  let response = await postInput(base, { target: "s1", data: "first", raw: true });
  assert.equal(response.status, 200);
  response = await postInput(base, { target: "s1", data: "second", raw: true });
  assert.equal(response.status, 200);
  assert.deepEqual(terminal.inputs, [
    { target: "s1", data: "first" },
    { target: "s1", data: "second" },
  ]);

  response = await postInput(base, { target: "unauthorized", data: "l", raw: true });
  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, "TARGET_NOT_FOUND");

  response = await postInput(base, { target: "s1", data: "l", raw: true }, { "content-type": "application/json" });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "V2_CREDENTIAL_REQUIRED");
});
