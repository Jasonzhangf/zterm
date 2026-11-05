import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { frameToText } from "../src/terminal-ansi-serializer.mjs";
import { TerminalPort } from "../src/terminal-port.mjs";
import { createV1MuxFixture } from "./v1-mux-fixture.mjs";

const socket = `/tmp/zterm-r2f/unit-${process.pid}.sock`;
const session = `unit${process.pid}`;
const token = "unit-v1-token";

function tmux(args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startSession(t) {
  tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
  t.after(() => {
    try {
      execFileSync("tmux", ["-S", socket, "kill-session", "-t", session], { stdio: "ignore" });
    } catch {
      // The dedicated session is already gone.
    }
  });
}

async function startFixture(t, options = {}) {
  const fixture = createV1MuxFixture({ tmuxSocket: socket, authToken: token, ...options });
  const { port } = await fixture.listen();
  t.after(() => fixture.close());
  return { fixture, port };
}

async function waitFor(check, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("Timed out waiting for the expected terminal state.");
}

test("lists real tmux sessions and streams committed V1 mux frames", async (t) => {
  startSession(t);
  const { fixture, port } = await startFixture(t);
  const terminal = new TerminalPort({ wsUrl: `ws://127.0.0.1:${port}/ws?token=${token}` });
  t.after(() => terminal.close());

  const sessions = await terminal.listSessions();
  const listed = sessions.find((candidate) => candidate.name === session);
  assert.ok(listed, "the real tmux session must be listed through V1 mux");
  assert.ok(listed.stableId && listed.stableId.startsWith("tmux:v1:"));

  const frames = [];
  const subscription = await terminal.subscribe(session, (frame) => frames.push(frame));
  t.after(() => subscription.close());

  await waitFor(() => frames.length > 0);
  assert.ok(frames[0].lines.length > 0);

  const inboundTypes = fixture.recorded.frames.map((entry) => entry.frame.type);
  assert.ok(inboundTypes.length > 0);
  assert.ok(
    inboundTypes.every((type) => type.startsWith("mux-")),
    `after mux negotiation only mux frames may travel on the socket: ${inboundTypes.join(",")}`,
  );

  await terminal.input(session, "echo ZTERM_PORT_E2E\r");
  await waitFor(() => frames.some((frame) => frameToText(frame).includes("ZTERM_PORT_E2E")));
  assert.ok(
    fixture.recorded.frames.some((entry) => entry.frame.type === "mux-channel-message"
      && entry.frame.payload.message.type === "input"),
    "input must stay inside the mux channel envelope",
  );
});

test("reuses one channel for two subscribers and keeps tmux alive after close", async (t) => {
  startSession(t);
  const { fixture, port } = await startFixture(t);
  const terminal = new TerminalPort({ wsUrl: `ws://127.0.0.1:${port}/ws?token=${token}` });
  t.after(() => terminal.close());

  const first = [];
  const second = [];
  const firstSub = await terminal.subscribe(session, (frame) => first.push(frame));
  const secondSub = await terminal.subscribe(session, (frame) => second.push(frame));
  await waitFor(() => first.length > 0 && second.length > 0);
  assert.equal(fixture.recorded.channelOpen.length, 1);

  firstSub.close();
  await terminal.input(session, "echo ZTERM_PORT_SECOND\r");
  await waitFor(() => second.some((frame) => frameToText(frame).includes("ZTERM_PORT_SECOND")));
  assert.ok(fixture.openChannelCount >= 1);

  secondSub.close();
  await waitFor(() => fixture.openChannelCount === 0);
  assert.equal(tmux(["has-session", "-t", session]), "");
});

test("assembles multi-chunk frames and emits only committed snapshots", async (t) => {
  startSession(t);
  const { fixture, port } = await startFixture(t, { chunkSize: 4 });
  const terminal = new TerminalPort({ wsUrl: `ws://127.0.0.1:${port}/ws?token=${token}` });
  t.after(() => terminal.close());

  const frames = [];
  const subscription = await terminal.subscribe(session, (frame) => frames.push(frame));
  t.after(() => subscription.close());

  await waitFor(() => frames.length > 0);
  const chunked = fixture.recorded.bufferSync.filter((entry) => entry.payload.frameChunkCount > 1);
  assert.ok(chunked.length > 1, "the fixture must emit multiple chunk frames");
  for (const frame of frames) {
    assert.ok(
      frame.endIndex - frame.startIndex >= 1,
      "committed snapshots always cover a continuous range",
    );
    assert.equal(frame.lines.length, frame.endIndex - frame.startIndex);
  }
});

test("rejects missing and wrong V1 credentials before target access", async (t) => {
  startSession(t);
  const { port } = await startFixture(t);

  for (const wsUrl of [
    `ws://127.0.0.1:${port}/ws`,
    `ws://127.0.0.1:${port}/ws?token=wrong-token`,
  ]) {
    const terminal = new TerminalPort({ wsUrl });
    t.after(() => terminal.close());
    await assert.rejects(
      () => terminal.listSessions(),
      (error) => error && error.code === "V1_CONNECTION_AUTH_FAILED",
      `expected V1_CONNECTION_AUTH_FAILED for ${wsUrl}`,
    );
    await terminal.close();
  }
});
