#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;

const bannedPaths = [
  "apps",
  "examples",
  "e2e",
  "src",
  "web",
  "patches",
  "build.zig",
  "build.zig.zon",
  "packages/@wterm",
  "packages/@internal",
  ".agents/skills/wterm-mobile-dev/SKILL.md",
];

const staleReferences = [
  "packages/@wterm",
  "packages/@internal",
  "examples/",
  "apps/",
  "web/",
  "e2e/",
  "patches/",
  "build.zig",
  "@wterm/mobile",
];

const checkedFiles = [
  "README.md",
  "AGENTS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "vitest.workspace.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/android-release.yml",
  ".agents/skills/zterm-mobile-dev/SKILL.md",
  ".agents/skills/terminal-buffer-truth/SKILL.md",
  "scripts/mempalace-mine-zterm.sh",
  "android/docs/architecture.md",
  "mac/docs/testing/mac-desktop-workspace-test-design.md",
];

const failures = [];

for (const relativePath of bannedPaths) {
  if (existsSync(join(root, relativePath))) {
    failures.push(`banned legacy path exists: ${relativePath}`);
  }
}

for (const relativePath of checkedFiles) {
  const absolutePath = join(root, relativePath);
  if (!existsSync(absolutePath)) continue;
  const content = readFileSync(absolutePath, "utf8");
  for (const token of staleReferences) {
    if (content.includes(token)) {
      failures.push(`${relativePath} still references ${token}`);
    }
  }
}

if (failures.length > 0) {
  console.error("Repo layout gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("Repo layout gate passed.");
