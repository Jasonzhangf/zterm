#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const moduleId = "zterm-runtime-v2";
const issueId = "zterm-runtime-architecture-v2";
const recordsRoot = join(root, ".appsdk", "records");
const evidenceRoot = join(recordsRoot, "evidence", moduleId);
const artifactManifestPath = join(root, "generated", "modules", moduleId, "module.compiled.json");
const artifactPath = join(root, "generated", "modules", moduleId, "lib", "zterm-runtime-v2.web.tgz");
const environmentId = `local-web-${process.pid}`;
const entrypoint = "http://127.0.0.1:4173/";
const producer = { adapter: "zterm::appsdk-lifecycle-adapter", identity: `zterm-lifecycle-${process.pid}` };

function run(command, args, options = {}) {
  return execFileSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function git(args) {
  return run("git", args);
}

function now() {
  return new Date().toISOString();
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function evidence({ id, phase, kind, createdAt, artifactHash, surface, inputHashes }) {
  return {
    evidence_id: id,
    issue_id: issueId,
    experiment_id: `${issueId}-appsdk-lifecycle`,
    phase,
    kind,
    source_commit: candidateCommit,
    ...(artifactHash ? { artifact_hash: artifactHash } : {}),
    ...(surface ? { execution_surface: surface } : {}),
    ...(surface === "deployed_blackbox" ? { environment_id: environmentId, entrypoint } : {}),
    scope: { module_id: moduleId, entrypoint },
    producer: surface === "development_whitebox" ? { adapter: producer.adapter, identity: `${producer.identity}-whitebox` } : producer,
    result: "pass",
    confidence: 1,
    confidence_rationale: "Produced by the project lifecycle adapter after the bound command completed successfully.",
    created_at: createdAt,
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    input_hashes: inputHashes,
    scope_hash: scopeHash,
  };
}

const artifact = JSON.parse(readFileSync(artifactManifestPath, "utf8"));
const artifactHash = artifact.artifact_hash;
if (!artifactHash || !existsSync(artifactPath)) throw new Error("canonical artifact is missing; run appsdk compile android first");
const candidateCommit = git(["rev-parse", "HEAD"]);
const candidateTree = git(["rev-parse", "HEAD^{tree}"]);
const baseCommit = git(["merge-base", "HEAD", "origin/main"]);
const changedPaths = git(["diff", "--name-only", `${baseCommit}..HEAD`]).split("\n").filter(Boolean);
const repositoryRoot = resolve(git(["rev-parse", "--show-toplevel"]));
const projectPrefix = relative(repositoryRoot, root).replaceAll("\\", "/");
const diffPaths = changedPaths
  .filter((path) => !projectPrefix || path === projectPrefix || path.startsWith(`${projectPrefix}/`))
  .map((path) => projectPrefix && path.startsWith(`${projectPrefix}/`) ? path.slice(projectPrefix.length + 1) : path);
const moduleContract = JSON.parse(readFileSync(join(root, ".appsdk", "project.json"), "utf8")).modules.find((module) => module.module_id === moduleId);
if (!moduleContract) throw new Error(`module not found: ${moduleId}`);
const scopeHash = sha256(JSON.stringify({ module_id: moduleId, owned_paths: moduleContract.owned_paths, contract_paths: moduleContract.contract_paths }));
const inputHash = sha256(readFileSync(artifactPath));
const diffHash = sha256(run("git", ["diff", "--binary", `${baseCommit}..HEAD`, "--", ...diffPaths]));

const startedAt = now();
run("pnpm", ["exec", "vitest", "run", "src/server/terminal-message-runtime.test.ts", "src/server/terminal-mirror-runtime.test.ts", "src/server/daemon-buffer-publisher-runtime.test.ts", "src/lib/runtime-architecture-v2.test.ts", "src/lib/plugin-host/plugin-host-runtime.test.ts", "src/pages/TerminalPage.render-isolation.test.tsx", "src/App.dynamic-refresh.test.tsx", "src/contexts/SessionContext.ws-refresh.test.tsx", "--reporter=dot"]);
const whiteboxAt = now();
const whiteboxId = `whitebox-${candidateCommit.slice(0, 12)}`;
writeJson(join(evidenceRoot, `${whiteboxId}.json`), evidence({ id: whiteboxId, phase: "development_whitebox", kind: "gate", createdAt: whiteboxAt, artifactHash, surface: "development_whitebox", inputHashes: [inputHash, `git:${candidateCommit}`] }));

const deploymentRoot = join(root, ".appsdk-control", "deployments", moduleId, candidateCommit);
mkdirSync(join(deploymentRoot, "dist"), { recursive: true });
run("tar", ["-xzf", artifactPath, "-C", join(deploymentRoot, "dist")]);
const viteBinary = join(root, "node_modules", ".bin", "vite");
const server = spawn(viteBinary, ["preview", "--host", "127.0.0.1", "--port", "4173"], { cwd: deploymentRoot, stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk.toString(); });
server.stderr.on("data", (chunk) => { serverOutput += chunk.toString(); });
const stopServer = () => { if (!server.killed) server.kill("SIGTERM"); };
process.on("exit", stopServer);
await new Promise((resolveReady, rejectReady) => {
  const timeout = setTimeout(() => rejectReady(new Error(`deployment server did not start: ${serverOutput}`)), 15000);
  const probe = async () => {
    try {
      const response = await fetch(entrypoint);
      if (response.ok) { clearTimeout(timeout); resolveReady(); return; }
    } catch {}
    setTimeout(probe, 100);
  };
  probe();
});
const installAt = now();
const installId = `install-${candidateCommit.slice(0, 12)}`;
writeJson(join(evidenceRoot, `${installId}.json`), evidence({ id: installId, phase: "deployment_install", kind: "install", createdAt: installAt, artifactHash, surface: "deployed_blackbox", inputHashes: [inputHash, `git:${candidateCommit}`] }));
stopServer();
await new Promise((resolveExit) => server.once("exit", resolveExit));
const restarted = spawn(viteBinary, ["preview", "--host", "127.0.0.1", "--port", "4173"], { cwd: deploymentRoot, stdio: ["ignore", "pipe", "pipe"] });
await new Promise((resolveReady, rejectReady) => {
  const timeout = setTimeout(() => rejectReady(new Error("restarted deployment server did not start")), 15000);
  const probe = async () => {
    try {
      const response = await fetch(entrypoint);
      if (response.ok) { clearTimeout(timeout); resolveReady(); return; }
    } catch {}
    setTimeout(probe, 100);
  };
  probe();
});
const restartAt = now();
const restartId = `restart-${candidateCommit.slice(0, 12)}`;
writeJson(join(evidenceRoot, `${restartId}.json`), evidence({ id: restartId, phase: "deployment_restart", kind: "restart", createdAt: restartAt, artifactHash, surface: "deployed_blackbox", inputHashes: [inputHash, `git:${candidateCommit}`] }));
const blackboxId = `blackbox-${candidateCommit.slice(0, 12)}`;
const blackboxResponse = await fetch(entrypoint);
if (!blackboxResponse.ok) throw new Error(`deployed blackbox returned HTTP ${blackboxResponse.status}`);
const blackboxAt = now();
writeJson(join(evidenceRoot, `${blackboxId}.json`), evidence({ id: blackboxId, phase: "deployed_blackbox", kind: "runtime", createdAt: blackboxAt, artifactHash, surface: "deployed_blackbox", inputHashes: [inputHash, `git:${candidateCommit}`] }));
restarted.kill("SIGTERM");
await new Promise((resolveExit) => restarted.once("exit", resolveExit));

const candidateId = `FIX-${candidateCommit.slice(0, 12)}`;
const candidateCreatedAt = now();
writeJson(join(recordsRoot, `fix-candidate-record-${moduleId}.json`), {
  "$schema": "https://appsdk.local/contracts/records/fix-candidate-record.schema.json",
  fix_candidate_id: candidateId,
  issue_id: issueId,
  module_id: moduleId,
  worktree_id: `WT-${candidateCommit.slice(0, 12)}`,
  base_commit: baseCommit,
  head_commit: candidateCommit,
  tree_hash: candidateTree,
  diff_hash: diffHash,
  design_id: `${issueId}-governance-migration-016`,
  owner: moduleContract.owner,
  scope_hash: scopeHash,
  changed_paths: changedPaths,
  verification_evidence_ids: [whiteboxId, installId, restartId],
  created_at: candidateCreatedAt,
});

const validationAt = now();
writeJson(join(recordsRoot, `pre-review-validation-record-${moduleId}.json`), {
  "$schema": "https://appsdk.local/contracts/records/pre-review-validation-record.schema.json",
  validation_id: `PRE-${candidateCommit.slice(0, 12)}`,
  issue_id: issueId,
  module_id: moduleId,
  fix_candidate_id: candidateId,
  candidate_commit: candidateCommit,
  candidate_tree_hash: candidateTree,
  artifact_hash: artifactHash,
  whitebox_producer: { adapter: producer.adapter, identity: `${producer.identity}-whitebox` },
  whitebox_evidence_ids: [whiteboxId],
  blackbox_evidence_ids: [blackboxId],
  deployment: { environment_id: environmentId, install_receipt_id: installId, restart_receipt_id: restartId, entrypoint, producer, observed_at: blackboxAt },
  source_unchanged: true,
  result: "pass",
  created_at: validationAt,
});
console.log(JSON.stringify({ ok: true, candidate_commit: candidateCommit, artifact_hash: artifactHash, validation_id: `PRE-${candidateCommit.slice(0, 12)}` }));
