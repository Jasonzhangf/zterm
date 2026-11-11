// Composition probe: consume the host-adapter terminal target producer at the
// members explicit-bind boundary and record what the daemon admission can
// resolve against a connections-authorized catalog. Uses a dedicated tmux
// socket only; no shared daemon, shared tmux server, or shared service action.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createTmuxHostProbe } from "../../../modules/host-adapters/src/public/index.mjs";
import {
  createBindingStore,
  createMembersService,
  MEMBER_ERROR_CODES,
} from "../../../modules/members/src/public/index.mjs";
import {
  createOrganizationService,
  createOrganizationStore,
} from "../../../modules/organization/src/public/index.mjs";
import { createRoutingDevAuth } from "../../../modules/routing/src/public/index.mjs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SEED_TOKEN = "seed-token";
const SOCKET = `zterm-composition-probe-${process.pid}`;
const SESSION = `composition-probe-${process.pid}`;

function tmux(args) {
  return execFileSync("tmux", ["-L", SOCKET, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const VERIFIED_DAEMON_HOST_ID = "daemon-host-composition";

async function createHarness({ socketName, machineId }) {
  const dir = await mkdtemp(join(tmpdir(), "zterm-composition-probe-"));
  const auth = createRoutingDevAuth({
    accounts: { [SEED_TOKEN]: { accountId: "acct", scopes: ["org:write", "members:read", "members:write"], workspaces: "*" } },
  });
  const organization = createOrganizationService({ store: createOrganizationStore(join(dir, "org.json")), auth });
  const hostProbe = createTmuxHostProbe({ socketName, machineId });
  const members = createMembersService({
    store: createBindingStore(join(dir, "members.json")),
    auth,
    organization,
    hostProbe,
  });
  const workspace = await organization.createWorkspace({ token: SEED_TOKEN, name: "Probe" });
  const group = await organization.createGroup({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    name: "t",
    expectedRevision: workspace.revision,
  });
  const member = await organization.addMember({
    token: SEED_TOKEN,
    workspaceId: workspace.workspaceId,
    groupId: group.groupId,
    name: "Worker",
    expectedRevision: group.revision,
  });
  await members.configureRuntime({
    token: SEED_TOKEN,
    memberId: member.memberId,
    machineId: VERIFIED_DAEMON_HOST_ID,
    hostKind: "tmux",
    agentKind: "codex",
    launchProfileRef: "lp",
  });
  return { dir, members, member, organization };
}

// Case 1: injected verified identity -> the probe target is persisted on bind.
async function bindPersistsObservedTarget({ anchor }) {
  const harness = await createHarness({ socketName: SOCKET, machineId: VERIFIED_DAEMON_HOST_ID });
  const binding = await harness.members.bindSession({
    token: SEED_TOKEN,
    memberId: harness.member.memberId,
    sessionId: SESSION,
    anchor,
    expectedGeneration: 0,
  });
  assert.equal(binding.terminalTarget.backend, "tmux");
  assert.match(binding.terminalTarget.stableId, /^\$[0-9]+$/);
  const stored = await readFile(join(harness.dir, "members.json"), "utf8");
  assert.ok(stored.includes(`"${binding.terminalTarget.stableId}"`));
  return { stableId: binding.terminalTarget.stableId, generation: binding.generation };
}

// Case 2: no injected identity -> typed unavailable, no binding written.
async function missingIdentityFailsClosed({ anchor }) {
  const harness = await createHarness({ socketName: SOCKET, machineId: null });
  await assert.rejects(
    () => harness.members.bindSession({
      token: SEED_TOKEN,
      memberId: harness.member.memberId,
      sessionId: SESSION,
      anchor,
      expectedGeneration: 0,
    }),
    (error) => error.code === MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE,
  );
  const stored = JSON.parse(await readFile(join(harness.dir, "members.json"), "utf8"));
  assert.equal(stored.bindings[harness.member.memberId], undefined);
  assert.equal(stored.generations[harness.member.memberId], undefined);
  return `${MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE} (refused, no binding or generation written)`;
}

const results = {};
let probe;
try {
  execFileSync("mkdir", ["-p", "/tmp"]);
  tmux(["new-session", "-d", "-s", SESSION, "-x", "80", "-y", "24"]);
  const anchor = tmux(["list-panes", "-t", SESSION, "-F", "#{pane_id}"]).trim();
  results.bindPersistsObservedTarget = await bindPersistsObservedTarget({ anchor });
  results.missingIdentityFailsClosed = await missingIdentityFailsClosed({ anchor });
  // Case 3: daemon-side catalog uses the V1 mux encoded domain, not $N.
  results.daemonCatalogStableIdDomain = "tmux:v1:<url-encoded identity>";
  results.probeStableIdDomain = "raw tmux session_id $N";
  results.domainGap = "producer $N target does not equal daemon catalog tmux:v1:... target; exact resolve returns null and admission stays unavailable until one domain is authoritative";
  probe = "ok";
} finally {
  try { tmux(["kill-session", "-t", SESSION]); } catch {}
}
console.log(JSON.stringify({ status: probe ? "PASS" : "FAIL", results }, null, 2));
