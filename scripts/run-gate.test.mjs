import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
