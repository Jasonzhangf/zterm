import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createDaemon } from "../src/server.mjs";
import { createV1MuxFixture } from "../../terminal/tests/v1-mux-fixture.mjs";

const SOCKET = `/tmp/zterm-r2f/slice-${process.pid}.sock`;
const SESSION = "r2slice";
const V1_TOKEN = "v1-slice-token";
const TOKEN = "v2-slice-token";

function tmux(args) {
  return execFileSync("tmux", ["-S", SOCKET, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startSession(t) {
  tmux(["new-session", "-d", "-s", SESSION, "-x", "90", "-y", "24"]);
  t.after(() => {
    try {
      execFileSync("tmux", ["-S", SOCKET, "kill-session", "-t", SESSION], { stdio: "ignore" });
    } catch {
      // The dedicated session is already gone.
    }
  });
}

async function startFixture(t, options = {}) {
  const fixture = createV1MuxFixture({ tmuxSocket: SOCKET, authToken: V1_TOKEN, ...options });
  const { port } = await fixture.listen();
  t.after(() => fixture.close());
  return { fixture, port };
}

async function startDaemon(t, { v1Token = V1_TOKEN, v1Port, v2Token = TOKEN } = {}) {
  const daemon = createDaemon({
    v1WsUrl: `ws://127.0.0.1:${v1Port}/ws?token=${encodeURIComponent(v1Token)}`,
    v1Token,
    v2Token,
    log: () => {},
  });
  const port = await new Promise((resolve, reject) => {
    daemon.server.once("error", reject);
    daemon.server.listen(0, "127.0.0.1", () => resolve(daemon.server.address().port));
  });
  t.after(() => new Promise((resolve) => daemon.server.close(resolve)));
  return { daemon, base: `http://127.0.0.1:${port}` };
}

const authHeaders = { authorization: `Bearer ${TOKEN}` };

test("daemon keeps the V1 session catalog token-gated while terminal data routes fail closed without admission", async (t) => {
  startSession(t);
  const { port: v1Port } = await startFixture(t);
  const { base } = await startDaemon(t, { v1Port });

  let response = await fetch(`${base}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, "ok");

  response = await fetch(`${base}/api/sessions`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "V2_CREDENTIAL_REQUIRED");

  response = await fetch(`${base}/api/sessions`, { headers: { authorization: "Bearer wrong-token" } });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "V2_CREDENTIAL_INVALID");

  response = await fetch(`${base}/api/sessions`, { headers: authHeaders });
  assert.equal(response.status, 200);
  const sessionsPayload = await response.json();
  assert.ok(sessionsPayload.sessions.some((session) => session.name === SESSION));
  assert.equal(sessionsPayload.observation.source, "v1-mux");

  response = await fetch(`${base}/api/terminal/stream?target=${SESSION}`, { headers: authHeaders });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "TERMINAL_ADMISSION_REQUIRED");

  response = await fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers: { ...authHeaders, "content-type": "application/json" },
    body: JSON.stringify({ target: SESSION, data: "echo SHOULD_NOT_RUN" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, "TERMINAL_ADMISSION_REQUIRED");
});

test("V1 credential failure maps to an explicit connection error before any target access", async (t) => {
  startSession(t);
  const { fixture, port: v1Port } = await startFixture(t);
  const { base } = await startDaemon(t, { v1Port, v1Token: "wrong-v1-token" });

  const response = await fetch(`${base}/api/sessions`, { headers: authHeaders });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, "V1_CONNECTION_AUTH_FAILED");
  assert.equal(fixture.recorded.channelOpen.length, 0, "no target may be read with a bad V1 credential");
  assert.equal(fixture.recorded.input.length, 0, "no input may be sent with a bad V1 credential");
});

test("cookie session no longer bypasses terminal admission", async (t) => {
  startSession(t);
  const { port: v1Port } = await startFixture(t);
  const { base } = await startDaemon(t, { v1Port });

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const { csrfToken } = await login.json();
  assert.ok(cookie.startsWith("zterm_v2_session="));
  assert.ok(csrfToken);

  const missingCsrf = await fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ target: SESSION, data: "echo NO_CSRF" }),
  });
  assert.equal(missingCsrf.status, 503);
  assert.equal((await missingCsrf.json()).error.code, "TERMINAL_ADMISSION_REQUIRED");

  const withCsrf = await fetch(`${base}/api/terminal/input`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json", "x-zterm-csrf": csrfToken },
    body: JSON.stringify({ target: SESSION, data: "echo WITH_CSRF" }),
  });
  assert.equal(withCsrf.status, 503);
  assert.equal((await withCsrf.json()).error.code, "TERMINAL_ADMISSION_REQUIRED");
});

async function openStream(url, headers) {
  const response = await fetch(url, { headers });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames = [];
  let frameWaiters = [];

  (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n\n")) !== -1) {
          const block = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          let event = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) {
              event = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              data += line.slice(5).trim();
            }
          }
          if (data && event === "buffer") {
            const payload = JSON.parse(data);
            frames.push(payload.buffer);
            frameWaiters = frameWaiters.filter((waiter) => !waiter(payload.buffer));
          }
        }
      }
    } catch {
      // The stream is intentionally closed by the test.
    }
  })();

  return {
    async waitForBuffer(predicate, timeoutMs) {
      const existing = frames.find(predicate);
      if (existing) {
        return existing;
      }
      return new Promise((resolve, reject) => {
        const waiter = (text) => {
          if (predicate(text)) {
            clearTimeout(timer);
            resolve(text);
            return true;
          }
          return false;
        };
        const timer = setTimeout(() => {
          frameWaiters = frameWaiters.filter((candidate) => candidate !== waiter);
          reject(new Error("Timed out waiting for a buffer frame."));
        }, timeoutMs);
        frameWaiters.push(waiter);
      });
    },
    close() {
      reader.cancel().catch(() => {});
    },
  };
}

async function waitFor(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out waiting for a condition.");
}
