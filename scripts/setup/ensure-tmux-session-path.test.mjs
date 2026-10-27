import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "setup",
  "ensure-tmux-session-path.sh",
);
const fixtures = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createHome(startupContent) {
  const home = mkdtempSync(join(tmpdir(), "zterm-tmux-path-home-"));
  fixtures.push(home);
  if (startupContent !== undefined) {
    mkdirSync(dirname(join(home, ".zshenv")), { recursive: true });
    writeFileSync(join(home, ".zshenv"), startupContent, "utf8");
  }
  return home;
}

function run(home, args = []) {
  const result = spawnSync("bash", [script, ...args], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
  };
}

function readStartup(home, name = ".zshenv") {
  return readFileSync(join(home, name), "utf8");
}

const EXPORT_LINE = 'export TMUX_TMPDIR="$HOME/.tmux/run"';

test("adds the standard TMUX_TMPDIR export to an empty home", () => {
  const home = createHome();
  const apply = run(home);
  assert.equal(apply.status, 0, apply.stderr);

  assert.ok(readStartup(home).includes(EXPORT_LINE));
  const standardDir = join(home, ".tmux", "run");
  assert.equal(spawnSync("test", ["-d", standardDir]).status, 0);
  const check = run(home, ["--check"]);
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /config .* -> .*\.tmux\/run/);
});

test("repoints an existing export to the standard root and stays idempotent", () => {
  const home = createHome("export PATH=/usr/bin:$PATH\nexport TMUX_TMPDIR=/tmp/tmux-legacy\nalias ll='ls -l'\n");
  const apply = run(home);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /repointed/);

  const content = readStartup(home);
  assert.ok(content.includes(EXPORT_LINE));
  assert.ok(!content.includes("tmux-legacy"));
  assert.ok(content.includes("export PATH=/usr/bin:$PATH"));
  assert.ok(content.includes("alias ll='ls -l'"));

  const rerun = run(home);
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.match(rerun.stdout, /unchanged/);
  assert.equal(readStartup(home), content);
});

test("repoints an export declared in a secondary startup file", () => {
  const home = createHome();
  writeFileSync(join(home, ".zshrc"), "export TMUX_TMPDIR=/tmp/tmux-legacy\n", "utf8");
  const apply = run(home);
  assert.equal(apply.status, 0, apply.stderr);
  assert.match(apply.stdout, /repointed/);
  assert.equal(readStartup(home, ".zshrc"), EXPORT_LINE + "\n");
  assert.equal(run(home, ["--check"]).status, 0);
});

test("check reports the failure of a missing export", () => {
  const home = createHome();
  const check = run(home, ["--check"]);
  assert.equal(check.status, 1);
  assert.match(check.stdout, /config .*no shell startup file exports TMUX_TMPDIR/);
});

test("check does not modify any file", () => {
  const home = createHome("export TMUX_TMPDIR=/tmp/other\n");
  const before = readStartup(home);
  const check = run(home, ["--check"]);
  assert.equal(check.status, 1);
  assert.equal(readStartup(home), before);
});

test("rejects an unknown argument", () => {
  const home = createHome();
  const result = run(home, ["--nope"]);
  assert.equal(result.status, 64);
});
