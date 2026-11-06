import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { TerminalPort } from "../../../modules/terminal/src/terminal-port.mjs";
import { createV1MuxFixture } from "../../../modules/terminal/tests/v1-mux-fixture.mjs";

const socket = `/tmp/zterm-r4f/probe-${process.pid}.sock`;
const session = `probe${process.pid}`;
const token = "r4f-probe-token";

function tmux(args) {
  return execFileSync("tmux", ["-S", socket, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

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

tmux(["new-session", "-d", "-s", session, "-x", "80", "-y", "24"]);
const fixture = createV1MuxFixture({ tmuxSocket: socket, authToken: token, autoCapture: false });
const { port } = await fixture.listen();
const terminal = new TerminalPort({ wsUrl: `ws://127.0.0.1:${port}/ws?token=${token}` });
const frames = [];
const subscription = await terminal.subscribe(session, (frame) => frames.push(frame));

fixture.emitChannelMessage(message(payload({
  revision: 1,
  frameStartIndex: 0,
  frameEndIndex: 3,
  startIndex: 0,
  endIndex: 3,
  chars: ["a", "b", "c"],
})));
await waitFor(() => frames.length === 1);

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
const request = fixture.recorded.bufferSyncRequests[0].message.payload;

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

const summary = {
  committedBeforeRepair: {
    count: frames.filter((frame) => frame.revision <= 1).length,
    revision: frames[0].revision,
    startIndex: frames[0].startIndex,
    endIndex: frames[0].endIndex,
  },
  wireRequest: {
    knownRevision: request.knownRevision,
    localStartIndex: request.localStartIndex,
    localEndIndex: request.localEndIndex,
    requestStartIndex: request.requestStartIndex,
    requestEndIndex: request.requestEndIndex,
  },
  committedFrames: frames.map((frame) => ({
    revision: frame.revision,
    startIndex: frame.startIndex,
    endIndex: frame.endIndex,
    text: frame.lines.map((item) => item.cells.map((entry) => String.fromCodePoint(entry.char)).join("")).join("|"),
  })),
  repairedCommitCount: frames.filter((frame) => frame.revision === 3).length,
};
console.log(JSON.stringify(summary, null, 2));

subscription.close();
await terminal.close();
await fixture.close();
try {
  tmux(["kill-session", "-t", session]);
} catch {
  // The dedicated probe session is already gone.
}

assert.equal(summary.committedBeforeRepair.count, 1, "the committed frame must survive the rejection");
assert.equal(summary.wireRequest.requestStartIndex, 0);
assert.equal(summary.wireRequest.requestEndIndex, 3);
assert.equal(summary.repairedCommitCount, 1, "the repair must commit exactly one complete frame");
