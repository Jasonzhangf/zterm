import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { TypedError } from "../../errors/src/public/index.mjs";
import { createTmuxHostProbe } from "../src/public/index.mjs";

const socketName = `zterm-v2-host-probe-${process.pid}`;
const sessionName = `host-probe-${process.pid}`;
const TMUX_V1_PREFIX = "tmux:v1:";

function parseTmuxV1Identity(stableId) {
  assert.ok(stableId.startsWith(TMUX_V1_PREFIX), `stableId must use the ${TMUX_V1_PREFIX} prefix`);
  return JSON.parse(decodeURIComponent(stableId.slice(TMUX_V1_PREFIX.length)));
}

function assertAuthoritativeTmuxIdentity(observation) {
  const stableId = observation.terminalTarget.stableId;
  const identity = parseTmuxV1Identity(stableId);
  assert.equal(identity.backend, "tmux");
  assert.equal(typeof identity.serverPid, "string");
  assert.notEqual(identity.serverPid, "");
  assert.equal(identity.sessionId, observation.sessionId);
  assert.match(identity.sessionId, /^\$[0-9]+$/);
  assert.equal(typeof identity.createdAt, "number");
  assert.ok(Number.isFinite(identity.createdAt));
  assert.notEqual(stableId, observation.sessionId);
  assert.notEqual(stableId, sessionName);
}

test("tmux host probe observes the exact session_id target", async (t) => {
  tmux(["new-session", "-d", "-s", sessionName]);
  t.after(() => tmux(["kill-session", "-t", sessionName]));

  const probe = createTmuxHostProbe({ socketName, machineId: "mac-probe" });
  const observation = await probe.probe({ sessionId: sessionName });

  assert.equal(observation.available, true);
  assert.equal(observation.machineId, "mac-probe");
  assert.equal(observation.terminalTarget.backend, "tmux");
  assertAuthoritativeTmuxIdentity(observation);
});

test("tmux host probe rejects a non-tmux backend at creation", () => {
  assert.throws(
    () => createTmuxHostProbe({ socketName, backend: "herdr" }),
    TypeError
  );
});

test("tmux host probe rejects an omitted machine identity at construction", () => {
  assert.throws(
    () => createTmuxHostProbe({ socketName }),
    (error) => error instanceof TypedError && error.code === "HOST_MACHINE_ID_REQUIRED",
  );
});

test("tmux host probe surfaces an injected authoritative machine identity", async (t) => {
  tmux(["new-session", "-d", "-s", sessionName]);
  t.after(() => tmux(["kill-session", "-t", sessionName]));

  const probe = createTmuxHostProbe({ socketName, machineId: "mac-1" });
  const observation = await probe.probe({ sessionId: sessionName });

  assert.equal(observation.available, true);
  assert.equal(observation.machineId, "mac-1");
});

test("tmux host probe reports anchorPresent true for a live pane", async (t) => {
  tmux(["new-session", "-d", "-s", sessionName]);
  t.after(() => tmux(["kill-session", "-t", sessionName]));

  const probe = createTmuxHostProbe({ socketName, machineId: "mac-probe" });
  const observation = await probe.probe({ sessionId: sessionName, anchor: "%0" });

  assert.equal(observation.available, true);
  assert.equal(observation.anchor, "%0");
  assert.equal(observation.anchorPresent, true);
  assert.match(observation.sessionId, /^\$[0-9]+$/);
});

test("tmux host probe reports anchorPresent false for a missing pane", async (t) => {
  tmux(["new-session", "-d", "-s", sessionName]);
  t.after(() => tmux(["kill-session", "-t", sessionName]));

  const probe = createTmuxHostProbe({ socketName, machineId: "mac-probe" });
  const observation = await probe.probe({ sessionId: sessionName, anchor: "%999" });

  assert.equal(observation.available, true);
  assert.equal(observation.anchor, "%999");
  assert.equal(observation.anchorPresent, false);
  assertAuthoritativeTmuxIdentity(observation);
});

test("tmux host probe reports unavailable for a missing session", async () => {
  const probe = createTmuxHostProbe({
    socketName: `zterm-v2-host-probe-missing-${process.pid}`,
    machineId: "mac-probe",
  });
  const observation = await probe.probe({ sessionId: "does-not-exist", anchor: "%999" });

  assert.equal(observation.available, false);
  assert.equal(observation.anchor, "%999");
  assert.equal(observation.anchorPresent, false);
  assert.equal(observation.terminalTarget, null);
  assert.equal(observation.errorCode, "TARGET_NOT_FOUND");
});

function tmux(args) {
  return execFileSync("tmux", ["-L", socketName, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
