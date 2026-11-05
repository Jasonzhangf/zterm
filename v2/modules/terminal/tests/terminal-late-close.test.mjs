import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { test } from "node:test";
import { frameToText } from "../src/terminal-ansi-serializer.mjs";
import { TerminalPort } from "../src/terminal-port.mjs";
import { createV1MuxFixture } from "./v1-mux-fixture.mjs";

const require = createRequire(import.meta.url);
const { WebSocket: NodeWebSocket } = require("ws");

const socket = `/tmp/zterm-late-close/unit-${process.pid}.sock`;
const sessionA = `latea${process.pid}`;
const sessionB = `lateb${process.pid}`;
const token = "late-close-unit-token";

function tmux(args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startSession(t, name) {
  tmux(["new-session", "-d", "-s", name, "-x", "80", "-y", "24"]);
  t.after(() => {
    try {
      tmux(["kill-session", "-t", name]);
    } catch {
      // The dedicated session is already gone.
    }
  });
}

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the expected terminal state.");
}

function failingWebSocketClass() {
  const state = { failNextClose: true };
  class FailingWebSocket extends NodeWebSocket {
    send(data) {
      let frame = null;
      try {
        frame = JSON.parse(String(data));
      } catch {
        frame = null;
      }
      if (state.failNextClose && frame && frame.type === "mux-channel-close") {
        state.failNextClose = false;
        throw new TypeError("injected late-open close send failure");
      }
      return super.send(data);
    }
  }
  return FailingWebSocket;
}

test("late-open close failure reaches the TerminalPort observer and retries one channel only", async (t) => {
  startSession(t, sessionA);
  startSession(t, sessionB);

  const FailingWebSocket = failingWebSocketClass();
  const fixture = createV1MuxFixture({
    tmuxSocket: socket,
    authToken: token,
    openDelaySessionName: sessionB,
    openDelayMs: 140,
  });
  const { port } = await fixture.listen();
  let terminal = null;
  t.after(() => {
    try {
      terminal?.close();
    } finally {
      fixture.close();
    }
  });

  terminal = new TerminalPort({
    wsUrl: `ws://127.0.0.1:${port}/ws?token=${token}`,
    WebSocketImpl: FailingWebSocket,
    requestTimeoutMs: 40,
  });

  assert.equal(typeof terminal.onChannelCloseFailure, "function", "TerminalPort must expose the channel close failure outlet");
  assert.equal(typeof terminal.retryLateOpenClose, "function", "TerminalPort must expose the late-open retry action");

  const failures = [];
  const unsubscribeFailure = terminal.onChannelCloseFailure((error) => failures.push(error));
  t.after(() => unsubscribeFailure());

  const aFrames = [];
  const subscriptionA = await terminal.subscribe(sessionA, (frame) => aFrames.push(frame));
  t.after(() => subscriptionA.close());
  await waitFor(() => aFrames.length > 0);
  assert.equal(fixture.openChannelCount, 1, "only session A owns an open channel before B is attempted");

  let timeoutError = null;
  try {
    await terminal.subscribe(sessionB, () => {});
  } catch (error) {
    timeoutError = error;
  }
  assert.ok(timeoutError, "the delayed session open must time out");
  assert.equal(timeoutError.code, "V1_CHANNEL_OPEN_TIMEOUT");
  assert.equal(typeof timeoutError.channelId, "string", "the open timeout must carry a structured channelId");

  await waitFor(() => failures.length === 1);
  assert.equal(failures[0].code, "V1_CHANNEL_CLOSE_FAILED");
  assert.equal(typeof failures[0].channelId, "string", "the close failure must carry a structured channelId");
  assert.equal(failures[0].channelId, timeoutError.channelId);
  const channelId = failures[0].channelId;

  assert.equal(terminal.retryLateOpenClose(channelId), true, "the failed late-open close must retry on this channel");
  assert.equal(terminal.retryLateOpenClose(channelId), false, "a released late-open channel must not retry twice");
  assert.equal(terminal.retryLateOpenClose("not-a-pending-channel"), false);

  await waitFor(() => fixture.recorded.channelClose.some((entry) => entry.channelId === channelId));
  assert.equal(fixture.openChannelCount, 1, "the retried close must release only the late-open channel");

  await terminal.input(sessionA, "echo LATE_CLOSE_A\r");
  await waitFor(() => aFrames.some((frame) => frameToText(frame).includes("LATE_CLOSE_A")));

  assert.equal(failures.length, 1, "no extra close failure may be reported");
  assert.equal(tmux(["has-session", "-t", sessionA]), "");
  assert.equal(tmux(["has-session", "-t", sessionB]), "");
});
