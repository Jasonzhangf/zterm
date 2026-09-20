import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  advisoryCheckedFiles,
  blockingCheckedFiles,
  checkRepoLayout,
} from "./check-repo-layout.mjs";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "check-repo-layout.mjs");
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture(files) {
  const root = mkdtempSync(join(tmpdir(), "zterm-repo-layout-"));
  fixtures.push(root);
  // The gate derives its root from its own location, so the fixture must own
  // an exact copy at <root>/scripts/check-repo-layout.mjs.
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(script, join(root, "scripts", "check-repo-layout.mjs"));
  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content);
  }
  return root;
}

function runFixture(root) {
  return spawnSync(process.execPath, [join(root, "scripts", "check-repo-layout.mjs")], {
    cwd: root,
    encoding: "utf8",
  });
}

test("build-input ownership split covers the CI wiring and the docs surface", () => {
  assert.ok(blockingCheckedFiles.includes(".github/workflows/ci.yml"));
  assert.ok(blockingCheckedFiles.includes("package.json"));
  assert.ok(advisoryCheckedFiles.includes("README.md"));
  assert.ok(advisoryCheckedFiles.includes("android/docs/architecture.md"));

  const overlap = blockingCheckedFiles.filter((file) => advisoryCheckedFiles.includes(file));
  assert.deepEqual(overlap, [], "a file must not be both blocking and advisory");
});

test("a stale reference in build wiring blocks delivery", () => {
  const root = createFixture({
    "package.json": JSON.stringify({ name: "zterm", note: "see examples/ for samples" }),
  });

  const { blocking, advisory } = checkRepoLayout(root);
  assert.deepEqual(advisory, []);
  assert.deepEqual(blocking, ["package.json still references examples/"]);

  const result = runFixture(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /package\.json still references examples\//);
});

test("a stale reference in docs history warns without blocking", () => {
  const root = createFixture({
    "README.md": "# zterm\n\nLegacy layout used examples/ before the split.\n",
    "package.json": JSON.stringify({ name: "zterm" }),
  });

  const { blocking, advisory } = checkRepoLayout(root);
  assert.deepEqual(blocking, []);
  assert.deepEqual(advisory, ["README.md still references examples/"]);

  const result = runFixture(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /\[WARN\] repo-layout: README\.md still references examples\//);
  assert.match(result.stdout, /Repo layout gate passed\./);
});

test("a banned legacy path still blocks regardless of severity split", () => {
  const root = createFixture({
    "package.json": JSON.stringify({ name: "zterm" }),
    "examples/legacy.txt": "removed layout",
  });

  const { blocking } = checkRepoLayout(root);
  assert.deepEqual(blocking, ["banned legacy path exists: examples"]);

  const result = runFixture(root);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /banned legacy path exists: examples/);
});
