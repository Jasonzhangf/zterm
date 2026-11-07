import assert from "node:assert/strict";
import { test } from "node:test";
import { TerminalPort } from "../src/terminal-port.mjs";

const TARGET = "target";
const OTHER_TARGET = "other";

function cell(char) {
  return { char: char.codePointAt(0), fg: 256, bg: 256, flags: 0, width: 1 };
}

function line(index, text) {
  return { index, cells: [...text].map(cell) };
}

function framePayload(options = {}) {
  const revision = options.revision ?? 1;
  const startIndex = options.startIndex ?? 0;
  const textLines = options.textLines ?? ["ab"];
  const endIndex = options.endIndex ?? startIndex + textLines.length;
  return {
    revision,
    startIndex,
    endIndex,
    frameStartIndex: options.frameStartIndex ?? startIndex,
    frameEndIndex: options.frameEndIndex ?? endIndex,
    frameChunkIndex: options.frameChunkIndex ?? 0,
    frameChunkCount: options.frameChunkCount ?? 1,
    generatedAt: options.generatedAt ?? revision,
    cols: options.cols ?? 2,
    rows: options.rows ?? 2,
    cursor: { rowIndex: 0, col: 0, visible: true },
    lines: textLines.map((text, offset) => line(startIndex + offset, text)),
  };
}

function bufferSync(payload) {
  return { type: "buffer-sync", payload };
}

function channelClosed(reason = "server closed") {
  return { type: "mux-channel-closed", payload: { reason } };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createFakeMux(options = {}) {
  const sessions = [
    { name: TARGET, backend: "tmux", stableId: "tmux:v1:unit" },
    { name: OTHER_TARGET, backend: "tmux", stableId: "tmux:v1:other" },
  ];
  const channels = new Map();
  const pendingOpens = new Map();
  const wire = [];
  const closeListeners = new Set();
  const channelCloseFailureListeners = new Set();
  const cancelOpenCalls = [];
  const closedChannelIds = [];
  let nextChannel = 0;
  let lastOpenChannelId = null;

  return {
    wire,
    cancelOpenCalls,
    closedChannelIds,
    get pendingOpenCount() {
      return pendingOpens.size;
    },
    get lastOpenChannelId() {
      return lastOpenChannelId;
    },
    opens: 0,
    closes: 0,
    failNextSend: null,
    closed: false,
    async connect() {},
    async requestTarget() {
      return {
        message: {
          payload: {
            sessions: sessions.map((session) => session.name),
            sessionCatalog: sessions,
          },
        },
      };
    },
    openChannel(input) {
      const channelId = `channel-${++nextChannel}`;
      lastOpenChannelId = channelId;
      const channel = {
        channelId,
        sessionName: input.sessionName,
        stableId: input.stableId,
        backend: input.backend,
        bodySubscribed: input.bodySubscribed !== false,
        listener: null,
        retainedListener: null,
        closed: false,
      };
      channels.set(channelId, channel);
      this.opens += 1;
      if (!options.deferredOpen) {
        const opened = Promise.resolve({ ...channel });
        opened.channelId = channelId;
        return opened;
      }
      const open = deferred();
      open.promise.channelId = channelId;
      pendingOpens.set(channelId, { channel, open });
      return open.promise;
    },
    resolveOpen(channelId) {
      const pending = pendingOpens.get(channelId);
      if (!pending) {
        throw new Error(`unknown pending open ${channelId}`);
      }
      pendingOpens.delete(channelId);
      pending.open.resolve({ ...pending.channel });
    },
    cancelOpenChannel(channelId) {
      cancelOpenCalls.push(channelId);
      return pendingOpens.has(channelId);
    },
    subscribeChannel(channelId, listener) {
      const channel = channels.get(channelId);
      if (!channel) {
        throw new Error(`unknown channel ${channelId}`);
      }
      channel.listener = listener;
      channel.retainedListener = listener;
      return () => {
        if (channel.listener === listener) {
          channel.listener = null;
        }
      };
    },
    sendChannelMessage(channelId, message) {
      if (this.failNextSend) {
        const error = this.failNextSend;
        this.failNextSend = null;
        throw error;
      }
      wire.push({ channelId, message });
    },
    closeChannel(channelId, reason) {
      const channel = channels.get(channelId);
      this.closes += 1;
      closedChannelIds.push(channelId);
      if (channel) {
        channel.closed = true;
        channel.closeReason = reason;
      }
    },
    onClose(listener) {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
    onChannelCloseFailure(listener) {
      channelCloseFailureListeners.add(listener);
      return () => channelCloseFailureListeners.delete(listener);
    },
    close() {
      this.closed = true;
    },
    emit(channelId, message) {
      const channel = channels.get(channelId);
      channel?.listener?.(message);
    },
    emitRetained(channelId, message) {
      const channel = channels.get(channelId);
      channel?.retainedListener?.(message);
    },
    channel(channelId) {
      return channels.get(channelId);
    },
  };
}

function makeHarness(options = {}) {
  const mux = createFakeMux(options);
  const terminal = new TerminalPort({ muxClient: mux, log: () => {} });
  return { mux, terminal };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function entryFor(terminal) {
  return terminal.targets.get("tmux:v1:unit");
}

function repairRequests(mux) {
  return mux.wire.filter((item) => item.message.type === "buffer-sync-request");
}

test("cached frame reaches a live second subscriber and stops after it closes", async (t) => {
  const { mux, terminal } = makeHarness();
  t.after(() => terminal.close());

  const firstFrames = [];
  const secondFrames = [];
  const first = await terminal.subscribe(TARGET, (frame) => firstFrames.push(frame));
  t.after(() => first.close());

  const channelId = entryFor(terminal).channel.channelId;
  mux.emit(channelId, bufferSync(framePayload({ revision: 1, textLines: ["aa", "bb"] })));
  await flushMicrotasks();
  assert.equal(firstFrames.length, 1);

  const second = await terminal.subscribe(TARGET, (frame) => secondFrames.push(frame));
  await flushMicrotasks();
  assert.equal(secondFrames.length, 1, "the later subscriber reads the committed cached frame");
  assert.equal(secondFrames[0].revision, 1);
  assert.equal(mux.opens, 1, "same target must reuse the channel");

  second.close();
  mux.emit(channelId, bufferSync(framePayload({ revision: 2, textLines: ["cc", "dd"] })));
  await flushMicrotasks();

  assert.equal(firstFrames.length, 2, "the active subscriber keeps receiving frames");
  assert.equal(secondFrames.length, 1, "a cancelled subscriber must not receive later frames");
  assert.equal(mux.closes, 0, "cancelling one of two subscribers must keep the shared channel");
});

async function establishReplacedEntry(t) {
  const { mux, terminal } = makeHarness();
  t.after(() => terminal.close());

  const firstFrames = [];
  const first = await terminal.subscribe(TARGET, (frame) => firstFrames.push(frame));
  const oldChannelId = entryFor(terminal).channel.channelId;

  first.close();
  assert.equal(mux.closes, 1);

  const secondFrames = [];
  const second = await terminal.subscribe(TARGET, (frame) => secondFrames.push(frame));
  t.after(() => second.close());
  const newChannelId = entryFor(terminal).channel.channelId;
  assert.notEqual(newChannelId, oldChannelId);
  assert.equal(mux.opens, 2);

  mux.emit(newChannelId, bufferSync(framePayload({ revision: 2, textLines: ["cc", "dd"] })));
  await flushMicrotasks();
  assert.equal(secondFrames.length, 1);

  return { mux, terminal, firstFrames, secondFrames, oldChannelId, newChannelId, second };
}

test("a stale frame cannot drive the old channel after the old entry is replaced", async (t) => {
  const { mux, firstFrames, secondFrames, oldChannelId } = await establishReplacedEntry(t);

  mux.emitRetained(oldChannelId, bufferSync(framePayload({ revision: 3, textLines: ["ee", "ff"] })));
  await flushMicrotasks();

  assert.equal(
    mux.wire.some((item) => item.channelId === oldChannelId && item.message.type === "buffer-head-request"),
    false,
    "a closed entry must ignore late frames instead of using the old channel",
  );
  assert.equal(secondFrames.length, 1, "an old channel frame must not reach the new entry");
  assert.equal(firstFrames.length, 0, "a released first subscriber must not receive late frames");
});

test("a stale close cannot delete the new entry that reused the target key", async (t) => {
  const { mux, terminal, oldChannelId, newChannelId } = await establishReplacedEntry(t);

  mux.emitRetained(oldChannelId, channelClosed("late close from the old channel"));
  await flushMicrotasks();

  const thirdFrames = [];
  const third = await terminal.subscribe(TARGET, (frame) => thirdFrames.push(frame));
  t.after(() => third.close());
  await flushMicrotasks();

  assert.equal(mux.opens, 2, "the live entry must not be removed by a stale close");
  assert.equal(entryFor(terminal).channel.channelId, newChannelId);
  assert.equal(thirdFrames.length, 1, "the third subscriber reads the live entry cache");
  assert.equal(thirdFrames[0].revision, 2);
});

test("multi-chunk frame stays pending until complete, then commits once", async (t) => {
  const { mux, terminal } = makeHarness();
  t.after(() => terminal.close());

  const frames = [];
  const subscription = await terminal.subscribe(TARGET, (frame) => frames.push(frame));
  t.after(() => subscription.close());

  const channelId = entryFor(terminal).channel.channelId;
  mux.emit(channelId, bufferSync(framePayload({
    revision: 1,
    frameChunkCount: 2,
    frameChunkIndex: 0,
    frameStartIndex: 0,
    frameEndIndex: 4,
    startIndex: 0,
    endIndex: 2,
    textLines: ["aa", "bb"],
    rows: 4,
  })));
  await flushMicrotasks();

  assert.equal(frames.length, 0, "an incomplete frame must not project a body");
  assert.equal(entryFor(terminal).runtime.getSnapshot().revision, 0, "an incomplete frame must not raise revision");
  assert.equal(repairRequests(mux).length, 0, "missing chunks must not synthesize a rejection repair");

  mux.emit(channelId, bufferSync(framePayload({
    revision: 1,
    frameChunkCount: 2,
    frameChunkIndex: 1,
    frameStartIndex: 0,
    frameEndIndex: 4,
    startIndex: 2,
    endIndex: 4,
    textLines: ["cc", "dd"],
    rows: 4,
  })));
  await flushMicrotasks();

  assert.equal(frames.length, 1, "the complete frame must commit exactly once");
  assert.equal(frames[0].revision, 1);
  assert.equal(frames[0].startIndex, 0);
  assert.equal(frames[0].endIndex, 4);
  assert.equal(frames[0].lines.length, 4);
  assert.deepEqual(
    frames[0].lines.map((item) => item.cells.map((value) => String.fromCodePoint(value.char)).join("")),
    ["aa", "bb", "cc", "dd"],
  );
  assert.equal(entryFor(terminal).runtime.getSnapshot().revision, 1);
});

test("explicit rejection repairs the exact range once per revision and retries after a wire failure", async (t) => {
  const { mux, terminal } = makeHarness();
  t.after(() => terminal.close());

  const frames = [];
  const subscription = await terminal.subscribe(TARGET, (frame) => frames.push(frame));
  t.after(() => subscription.close());

  const channelId = entryFor(terminal).channel.channelId;
  mux.emit(channelId, bufferSync(framePayload({ revision: 1, textLines: ["aa", "bb"] })));
  await flushMicrotasks();
  assert.equal(frames.length, 1);

  mux.failNextSend = new Error("injected wire failure");
  mux.emit(channelId, bufferSync(framePayload({ revision: 1, textLines: ["xx", "yy"] })));
  await flushMicrotasks();
  assert.equal(repairRequests(mux).length, 0, "a failed wire write must not be marked dispatched");
  assert.equal(entryFor(terminal).repairRequests.get(1).status, "failed");
  assert.equal(frames.length, 1, "the rejected frame must keep the committed body");

  mux.emit(channelId, bufferSync(framePayload({ revision: 1, textLines: ["xx", "yy"] })));
  await flushMicrotasks();
  const firstRequests = repairRequests(mux);
  assert.equal(firstRequests.length, 1);
  assert.equal(entryFor(terminal).repairRequests.get(1).status, "dispatched");
  assert.deepEqual(entryFor(terminal).repairRequests.get(1).repairRange, { startIndex: 0, endIndex: 2 });
  assert.equal(firstRequests[0].message.payload.requestStartIndex, 0);
  assert.equal(firstRequests[0].message.payload.requestEndIndex, 2);
  assert.equal(firstRequests[0].message.payload.knownRevision, 1);

  mux.emit(channelId, bufferSync(framePayload({ revision: 1, textLines: ["xx", "yy"] })));
  await flushMicrotasks();
  assert.equal(repairRequests(mux).length, 1, "one revision must dispatch at most one successful repair");

  mux.emit(channelId, bufferSync(framePayload({ revision: 2, textLines: ["mm", "nn"] })));
  await flushMicrotasks();
  assert.equal(frames.at(-1).revision, 2);

  mux.emit(channelId, bufferSync(framePayload({ revision: 2, textLines: ["pp", "qq"] })));
  await flushMicrotasks();
  assert.equal(repairRequests(mux).length, 2, "a different revision may dispatch a new repair");
  assert.equal(repairRequests(mux)[1].message.payload.requestStartIndex, 0);
  assert.equal(repairRequests(mux)[1].message.payload.requestEndIndex, 2);
});

test("closing one target does not release another target channel", async (t) => {
  const { mux, terminal } = makeHarness();
  t.after(() => terminal.close());

  const targetFrames = [];
  const otherFrames = [];
  const targetSub = await terminal.subscribe(TARGET, (frame) => targetFrames.push(frame));
  const otherSub = await terminal.subscribe(OTHER_TARGET, (frame) => otherFrames.push(frame));
  t.after(() => otherSub.close());

  const targetChannel = terminal.targets.get("tmux:v1:unit").channel.channelId;
  const otherChannel = terminal.targets.get("tmux:v1:other").channel.channelId;
  assert.notEqual(targetChannel, otherChannel);
  assert.equal(mux.opens, 2);

  mux.emit(otherChannel, bufferSync(framePayload({ revision: 1, textLines: ["oo", "pp"] })));
  await flushMicrotasks();
  assert.equal(otherFrames.length, 1);

  targetSub.close();
  assert.equal(mux.closes, 1);

  mux.emit(otherChannel, bufferSync(framePayload({ revision: 2, textLines: ["qq", "rr"] })));
  await flushMicrotasks();
  assert.equal(otherFrames.length, 2, "another target must keep its channel and subscriber");
  assert.equal(terminal.targets.get("tmux:v1:other").closed, false);
});

test("closing the last subscriber cancels its pending open exactly once", async (t) => {
  const { mux, terminal } = makeHarness({ deferredOpen: true });
  t.after(() => terminal.close());

  const subscription = await terminal.subscribe(TARGET, () => {});
  const entry = entryFor(terminal);
  const channelId = entry.channelId;
  assert.equal(entry.channel, null);

  subscription.close();

  assert.deepEqual(mux.cancelOpenCalls, [channelId]);
  assert.equal(entryFor(terminal), undefined, "the cancelled pending target must leave the registry");
  assert.equal(entry.closed, true);
  assert.equal(entry.openCancelled, true);
});

test("closing one of two pending subscribers keeps the shared open until the last subscriber leaves", async (t) => {
  const { mux, terminal } = makeHarness({ deferredOpen: true });
  t.after(() => terminal.close());

  const first = await terminal.subscribe(TARGET, () => {});
  const second = await terminal.subscribe(TARGET, () => {});
  const entry = entryFor(terminal);
  const channelId = entry.channelId;

  first.close();
  assert.deepEqual(mux.cancelOpenCalls, []);
  assert.equal(entryFor(terminal), entry, "the remaining subscriber must keep the pending target alive");

  second.close();
  assert.deepEqual(mux.cancelOpenCalls, [channelId]);
  assert.equal(entryFor(terminal), undefined);
});

test("attach holds a temporary lease while the shared subscriber leaves", async (t) => {
  const { mux, terminal } = makeHarness({ deferredOpen: true });
  t.after(() => terminal.close());

  const subscription = await terminal.subscribe(TARGET, () => {});
  const entry = entryFor(terminal);
  const channelId = entry.channelId;
  const attachPromise = terminal.attach(TARGET);
  await flushMicrotasks();

  subscription.close();
  assert.deepEqual(
    mux.cancelOpenCalls,
    [],
    "attach must keep the shared pending open alive after the subscriber leaves",
  );
  assert.equal(entryFor(terminal), entry);

  mux.resolveOpen(channelId);
  await flushMicrotasks();
  const attachment = await attachPromise;

  assert.equal(attachment.value.channelId, channelId, "attach must settle on the shared open");
  assert.equal(mux.channel(channelId).closed, true, "attach must release its last temporary lease");
  assert.equal(entry.closed, true);
});

test("a late open after cancellation closes the channel and cannot revive the target", async (t) => {
  const { mux, terminal } = makeHarness({ deferredOpen: true });
  t.after(() => terminal.close());

  const frames = [];
  const subscription = await terminal.subscribe(TARGET, (frame) => frames.push(frame));
  const entry = entryFor(terminal);
  const channelId = entry.channelId;

  subscription.close();
  mux.resolveOpen(channelId);
  await flushMicrotasks();

  assert.equal(entryFor(terminal), undefined, "a late open must not reinsert the cancelled target");
  assert.equal(entry.channel, null);
  assert.equal(entry.closed, true);
  assert.equal(mux.channel(channelId).closed, true, "the late channel must be released");
  assert.equal(frames.length, 0);
});

test("cancelling one pending target open does not affect another target", async (t) => {
  const { mux, terminal } = makeHarness({ deferredOpen: true });
  t.after(() => terminal.close());

  const otherFrames = [];
  const targetSub = await terminal.subscribe(TARGET, () => {});
  const otherSub = await terminal.subscribe(OTHER_TARGET, (frame) => otherFrames.push(frame));
  const targetEntry = entryFor(terminal);
  const otherEntry = terminal.targets.get("tmux:v1:other");

  mux.resolveOpen(otherEntry.channelId);
  await flushMicrotasks();

  targetSub.close();
  assert.deepEqual(mux.cancelOpenCalls, [targetEntry.channelId]);
  assert.equal(terminal.targets.get("tmux:v1:other"), otherEntry);
  assert.equal(otherEntry.closed, false);

  mux.emit(otherEntry.channelId, bufferSync(framePayload({ revision: 1, textLines: ["oo", "pp"] })));
  await flushMicrotasks();
  assert.equal(otherFrames.length, 1, "the other target must keep its open channel and frames");

  otherSub.close();
});
