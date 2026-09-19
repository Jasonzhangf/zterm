import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { constants as osConstants } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "run-gate.mjs");

function run(severity, exitCode) {
  return spawnSync(process.execPath, [
    script,
    "--severity",
    severity,
    "--name",
    "fixture-gate",
    "--",
    process.execPath,
    "-e",
    `process.exit(${exitCode})`,
  ], { encoding: "utf8" });
}

function runSignal(severity) {
  return spawnSync(process.execPath, [
    script,
    "--severity",
    severity,
    "--name",
    "signal-gate",
    "--",
    process.execPath,
    "-e",
    "process.kill(process.pid, 'SIGTERM')",
  ], { encoding: "utf8" });
}

test("block preserves a required gate failure", () => {
  const result = run("block", 7);
  assert.equal(result.status, 7);
  assert.match(result.stderr, /\[BLOCK\] fixture-gate: exit 7/);
});

test("warn reports a non-target failure without failing the enclosing gate", () => {
  const result = run("warn", 7);
  assert.equal(result.status, 0);
  assert.match(result.stderr, /\[WARN\] fixture-gate: exit 7/);
});

test("info reports advisory failure without failing the enclosing gate", () => {
  const result = run("info", 7);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /\[INFO\] fixture-gate: exit 7/);
});

test("a passing required gate stays silent and successful", () => {
  const result = run("block", 0);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("block preserves conventional signal exit status and diagnostic", () => {
  const result = runSignal("block");
  assert.equal(result.status, 128 + osConstants.signals.SIGTERM);
  assert.match(result.stderr, /\[BLOCK\] signal-gate: signal SIGTERM \(exit 143\)/);
});

test("warn and info retain signal diagnostics without failing", () => {
  const warn = runSignal("warn");
  assert.equal(warn.status, 0);
  assert.match(warn.stderr, /\[WARN\] signal-gate: signal SIGTERM \(exit 143\)/);

  const info = runSignal("info");
  assert.equal(info.status, 0);
  assert.match(info.stdout, /\[INFO\] signal-gate: signal SIGTERM \(exit 143\)/);
});
