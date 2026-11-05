import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { TypedError } from "../../errors/src/typed-error.mjs";
import { TmuxAdapter } from "../src/tmux/tmux-adapter.mjs";

const socketName = `zterm-v2-i0-host-test-${process.pid}`;
const sessionName = `host-test-${process.pid}`;
const marker = "ZTERM_V2_HOST_TEST";

test("tmux adapter lists, captures and sends input to a real session", async (t) => {
  tmux(["new-session", "-d", "-s", sessionName]);
  t.after(() => tmux(["kill-session", "-t", sessionName]));

  const adapter = new TmuxAdapter({ socketName });
  const sessions = await adapter.listSessions();
  assert.ok(sessions.some((session) => session.name === sessionName));

  await adapter.sendKeys(sessionName, `echo ${marker}`);
  await waitFor(async () => (await adapter.capture(sessionName)).includes(marker));

  const buffer = await adapter.capture(sessionName);
  assert.match(buffer, new RegExp(marker));
});

test("tmux adapter returns a typed error for a missing target", async (t) => {
  tmux(["new-session", "-d", "-s", sessionName]);
  t.after(() => tmux(["kill-session", "-t", sessionName]));

  const adapter = new TmuxAdapter({ socketName });
  await assert.rejects(
    () => adapter.capture("does-not-exist"),
    (error) => error instanceof TypedError && error.code === "TARGET_NOT_FOUND",
  );
});

test("tmux adapter reports no sessions when the dedicated server is absent", async () => {
  const adapter = new TmuxAdapter({ socketName: `zterm-v2-i0-missing-${process.pid}` });
  assert.deepEqual(await adapter.listSessions(), []);
});

function tmux(args) {
  return execFileSync("tmux", ["-L", socketName, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for tmux output.");
}
