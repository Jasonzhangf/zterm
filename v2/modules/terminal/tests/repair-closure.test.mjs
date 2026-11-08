import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { createTerminalBufferRenderRuntime } from "@zterm/stream-boundary";
import { TerminalPort } from "../src/terminal-port.mjs";
import { createV1MuxFixture } from "./v1-mux-fixture.mjs";

const socket = `/tmp/zterm-r4f/repair-${process.pid}.sock`;
const session = `repair${process.pid}`;
const token = "r4f-unit-token";

function cell(char) {
  return { char: char.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 };
}

function line(index, text) {
  return { index, cells: [...text].map(cell) };
}

function payload(options = {}) {
  const revision = options.revision ?? 1;
  const frameChunkCount = options.frameChunkCount ?? 1;
  const frameChunkIndex = options.frameChunkIndex ?? 0;
  const frameStartIndex = options.frameStartIndex ?? 0;
  const frameEndIndex = options.frameEndIndex ?? 2;
  const startIndex = options.startIndex ?? 0;
  const endIndex = options.endIndex ?? 2;
  const chars = options.chars ?? ["a", "b"];
  return {
    revision,
    startIndex,
    endIndex,
    frameStartIndex,
    frameEndIndex,
    frameChunkIndex,
    frameChunkCount,
    generatedAt: options.generatedAt ?? revision,
    cols: 2,
    rows: 2,
    cursor: { rowIndex: 0, col: 0, visible: true },
    lines: Array.from({ length: endIndex - startIndex }, (_, offset) => line(startIndex + offset, chars[offset] || " ")),
  };
}

function message(value) {
  return { type: "buffer-sync", payload: value };
}

function makeHarness() {
  const wire = [];
  const logs = [];
  let failNextRepair = false;
  const client = {
    onClose() {
      return () => {};
    },
    sendChannelMessage(channelId, value) {
      if (value.type === "buffer-sync-request" && failNextRepair) {
        failNextRepair = false;
        throw new Error("wire down");
      }
      wire.push({ channelId, message: value });
    },
    closeChannel() {},
  };
  return {
    terminal: new TerminalPort({ muxClient: client, log: (entry) => logs.push(entry) }),
    wire,
    logs,
    failNextRepair() {
      failNextRepair = true;
    },
  };
}

function makeEntry() {
  return {
    key: "target",
    session: { name: "target", backend: "tmux", stableId: "tmux:v1:unit" },
    channel: { channelId: "channel-1" },
    runtime: createTerminalBufferRenderRuntime(),
    subscribers: new Set(),
    leases: 0,
    lastFrame: null,
    lastHead: null,
    closed: false,
    unsubscribe: null,
    headRequested: true,
  };
}

function tmux(args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function startSession(t) {
  execFileSync("mkdir", ["-p", path.dirname(socket)]);
  tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
  t.after(() => {
    try {
      tmux(["kill-session", "-t", session]);
    } catch {
      // The dedicated session is already gone.
    }
  });
}

async function startFixture(t) {
  const fixture = createV1MuxFixture({
    tmuxSocket: socket,
    authToken: token,
    autoCapture: false,
  });
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for the expected terminal state.");
}

function repairRequests(wire) {
  return wire.filter((entry) => entry.message.type === "buffer-sync-request");
}

test("frame repair keeps the committed frame, writes the exact range, and dispatches once per revision", () => {
  const { terminal, wire, failNextRepair } = makeHarness();
  const entry = makeEntry();

  terminal.handleChannelMessage(entry, message(payload({ revision: 1, chars: ["a", "b"] })));
  assert.equal(entry.lastFrame.revision, 1);

  const conflicting = payload({ revision: 1, chars: ["x", "y"], generatedAt: 2 });
  failNextRepair();
  terminal.handleChannelMessage(entry, message(conflicting));
  assert.equal(entry.repairRequests.get(1).status, "failed");
  assert.equal(repairRequests(wire).length, 0, "no request is recorded when the wire write fails");
  assert.equal(entry.lastFrame.revision, 1, "rejection must preserve the committed frame");

  terminal.handleChannelMessage(entry, message(conflicting));
  const first = repairRequests(wire);
  assert.equal(first.length, 1);
  assert.equal(entry.repairRequests.get(1).status, "dispatched");
  assert.deepEqual(entry.repairRequests.get(1).repairRange, { startIndex: 0, endIndex: 2 });
  const request = first[0].message.payload;
  assert.equal(request.knownRevision, 1);
  assert.equal(request.localStartIndex, 0);
  assert.equal(request.localEndIndex, 2);
  assert.equal(request.requestStartIndex, 0);
  assert.equal(request.requestEndIndex, 2);
  assert.equal(request.cols, 2);
  assert.equal(request.rows, 2);
  assert.deepEqual(request.lines.map((item) => item.index), [0, 1]);
  assert.ok(Number.isFinite(request.requestedAt));

  terminal.handleChannelMessage(entry, message(conflicting));
  assert.equal(repairRequests(wire).length, 1, "a dispatched revision must not dispatch again");

  terminal.handleChannelMessage(entry, message(payload({ revision: 2, chars: ["n", "m"], generatedAt: 3 })));
  terminal.handleChannelMessage(entry, message(payload({ revision: 2, chars: ["p", "q"], generatedAt: 4 })));
  assert.equal(repairRequests(wire).length, 2, "a new revision may dispatch a new repair");
  assert.equal(entry.lastFrame.revision, 2);
});

test("interleaved rejection dispatches the runtime repair range", () => {
  const { terminal, wire } = makeHarness();
  const entry = makeEntry();

  terminal.handleChannelMessage(entry, message(payload({
    revision: 5,
    frameChunkCount: 2,
    frameChunkIndex: 0,
    frameStartIndex: 0,
    frameEndIndex: 2,
    startIndex: 0,
    endIndex: 1,
    chars: ["a"],
    generatedAt: 5,
  })));
  terminal.handleChannelMessage(entry, message(payload({
    revision: 5,
    frameChunkCount: 3,
    frameChunkIndex: 0,
    frameStartIndex: 0,
    frameEndIndex: 3,
    startIndex: 0,
    endIndex: 1,
    chars: ["b"],
    generatedAt: 6,
  })));

  const requests = repairRequests(wire);
  assert.equal(requests.length, 1);
  assert.deepEqual(entry.repairRequests.get(5).repairRange, { startIndex: 0, endIndex: 2 });
  assert.equal(requests[0].message.payload.requestStartIndex, 0);
  assert.equal(requests[0].message.payload.requestEndIndex, 2);
  assert.equal(entry.lastFrame, null);
});

test("invalid-frame rejection dispatches its valid repair range", () => {
  const { terminal, wire } = makeHarness();
  const entry = makeEntry();
  const invalid = payload({
    revision: 5,
    frameStartIndex: 90,
    frameEndIndex: 92,
    startIndex: 90,
    endIndex: 92,
    chars: ["x", "y"],
    generatedAt: 5,
  });
  invalid.lines = invalid.lines.slice(0, 1);

  terminal.handleChannelMessage(entry, message(invalid));

  const requests = repairRequests(wire);
  assert.equal(requests.length, 1);
  assert.deepEqual(entry.repairRequests.get(5).repairRange, { startIndex: 90, endIndex: 92 });
  assert.equal(requests[0].message.payload.requestStartIndex, 90);
  assert.equal(requests[0].message.payload.requestEndIndex, 92);
  assert.deepEqual(requests[0].message.payload.lines, []);
});

test("repair keeps the exact non-overlapping wire range outside the local cache", () => {
  const { terminal, wire } = makeHarness();
  const entry = makeEntry();
  terminal.handleChannelMessage(entry, message(payload({
    revision: 1,
    frameStartIndex: 100,
    frameEndIndex: 102,
    startIndex: 100,
    endIndex: 102,
    chars: ["a", "b"],
  })));
  assert.equal(entry.lastFrame.revision, 1);

  terminal.handleChannelMessage(entry, message(payload({
    revision: 1,
    frameStartIndex: 90,
    frameEndIndex: 92,
    startIndex: 90,
    endIndex: 92,
    chars: ["x", "y"],
    generatedAt: 2,
  })));

  const requests = repairRequests(wire);
  assert.equal(requests.length, 1);
  const request = requests[0].message.payload;
  assert.equal(request.localStartIndex, 100);
  assert.equal(request.localEndIndex, 102);
  assert.equal(request.requestStartIndex, 90);
  assert.equal(request.requestEndIndex, 92);
  assert.deepEqual(request.lines, []);
  assert.equal(entry.lastFrame.revision, 1);
});

test("stale-frame with a null repair range does not dispatch", () => {
  const { terminal, wire } = makeHarness();
  const entry = makeEntry();
  terminal.handleChannelMessage(entry, message(payload({ revision: 2 })));
  assert.equal(entry.lastFrame.revision, 2);

  terminal.handleChannelMessage(entry, message(payload({ revision: 1 })));

  assert.equal(repairRequests(wire).length, 0);
  assert.equal(entry.repairRequests, undefined);
  assert.equal(entry.lastFrame.revision, 2);
});

test("real V1 mux rejection requests an exact range and commits one complete repair frame", async (t) => {
  startSession(t);
  const { fixture, port } = await startFixture(t);
  const terminal = new TerminalPort({ wsUrl: `ws://127.0.0.1:${port}/ws?token=${token}` });
  t.after(() => terminal.close());
  const frames = [];
  const subscription = await terminal.subscribe(session, (frame) => frames.push(frame));
  await subscription.ready;
  t.after(() => subscription.close());

  fixture.emitChannelMessage(message(payload({
    revision: 1,
    frameStartIndex: 0,
    frameEndIndex: 3,
    startIndex: 0,
    endIndex: 3,
    chars: ["a", "b", "c"],
  })));
  await waitFor(() => frames.length === 1);
  assert.equal(frames[0].revision, 1);

  fixture.emitChannelMessage(message(payload({
    revision: 2,
    frameChunkCount: 2,
    frameChunkIndex: 0,
    frameStartIndex: 0,
    frameEndIndex: 3,
    startIndex: 0,
    endIndex: 2,
    chars: ["x", "y"],
    generatedAt: 2,
  })));
  fixture.emitChannelMessage(message(payload({
    revision: 2,
    frameChunkCount: 3,
    frameChunkIndex: 0,
    frameStartIndex: 0,
    frameEndIndex: 3,
    startIndex: 0,
    endIndex: 1,
    chars: ["z"],
    generatedAt: 3,
  })));

  await waitFor(() => fixture.recorded.bufferSyncRequests.length === 1);
  assert.equal(frames.length, 1, "the rejected frame must not replace the committed frame");
  const request = fixture.recorded.bufferSyncRequests[0].message.payload;
  assert.equal(request.requestStartIndex, 0);
  assert.equal(request.requestEndIndex, 3);

  fixture.emitChannelMessage(message(payload({
    revision: 3,
    frameStartIndex: 0,
    frameEndIndex: 3,
    startIndex: 0,
    endIndex: 3,
    chars: ["c", "d", "e"],
    generatedAt: 4,
  })));
  await waitFor(() => frames.some((frame) => frame.revision === 3));

  const repaired = frames.filter((frame) => frame.revision === 3);
  assert.equal(repaired.length, 1);
  assert.equal(repaired[0].startIndex, 0);
  assert.equal(repaired[0].endIndex, 3);
  assert.equal(repaired[0].lines.length, 3);
  assert.deepEqual(
    repaired[0].lines.map((line) => line.cells.map((entry) => String.fromCodePoint(entry.char)).join("")),
    ["c", "d", "e"],
  );
});

