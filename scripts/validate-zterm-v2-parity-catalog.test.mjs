import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

test("rejects duplicate IDs and unknown owner references", () => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = spawnSync(process.execPath, [
    resolve(repoRoot, "scripts/validate-zterm-v2-parity-catalog.mjs"),
    resolve(repoRoot, "scripts/fixtures/zterm-v2-parity-catalog.invalid.json"),
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0, "invalid fixture unexpectedly passed");
  assert.match(result.stderr, /duplicate feature id/);
  assert.match(result.stderr, /unknown Android registry feature not-a-real-feature/);
});
