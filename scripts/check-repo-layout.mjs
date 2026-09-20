#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const bannedPaths = [
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

export const staleReferences = [
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

// Build inputs and CI wiring: a stale reference here changes what actually
// builds or runs, so it blocks delivery.
export const blockingCheckedFiles = [
  "package.json",
  "pnpm-workspace.yaml",
  "vitest.workspace.ts",
  ".github/workflows/ci.yml",
  ".github/workflows/android-release.yml",
  "scripts/mempalace-mine-zterm.sh",
];

// Documentation, skills, and history: a stale reference here misleads readers
// but does not change build output, so it warns instead of blocking.
export const advisoryCheckedFiles = [
  "README.md",
  "AGENTS.md",
  ".agents/skills/zterm-mobile-dev/SKILL.md",
  ".agents/skills/terminal-buffer-truth/SKILL.md",
  "android/docs/architecture.md",
  "mac/docs/testing/mac-desktop-workspace-test-design.md",
];

export function checkRepoLayout(root) {
  const blocking = [];
  const advisory = [];

  for (const relativePath of bannedPaths) {
    if (existsSync(join(root, relativePath))) {
      blocking.push(`banned legacy path exists: ${relativePath}`);
    }
  }

  const scan = (files, sink) => {
    for (const relativePath of files) {
      const absolutePath = join(root, relativePath);
      if (!existsSync(absolutePath)) continue;
      const content = readFileSync(absolutePath, "utf8");
      for (const token of staleReferences) {
        if (content.includes(token)) {
          sink.push(`${relativePath} still references ${token}`);
        }
      }
    }
  };

  scan(blockingCheckedFiles, blocking);
  scan(advisoryCheckedFiles, advisory);

  return { blocking, advisory };
}

function main() {
  const root = new URL("..", import.meta.url).pathname;
  const { blocking, advisory } = checkRepoLayout(root);

  for (const failure of advisory) {
    console.error(`[WARN] repo-layout: ${failure}`);
  }

  if (blocking.length > 0) {
    console.error("Repo layout gate failed:");
    for (const failure of blocking) console.error(`- ${failure}`);
    process.exit(1);
  }

  console.log("Repo layout gate passed.");
}

// Compare real paths: macOS resolves /tmp to /private/tmp, so a raw string
// comparison would silently skip main() when the gate runs from a temp dir.
function isDirectInvocation() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectInvocation()) {
  main();
}
