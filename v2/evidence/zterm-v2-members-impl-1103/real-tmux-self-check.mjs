// Real-consumer self-check for members runtime config, binding CAS, the
// consistent routing reader, and the host reachability boundary. It runs
// against a dedicated disposable tmux socket and only closes the named sessions
// it created. The host probe fixture proves session/anchor existence only and
// deliberately returns no machine identity, because that identity belongs to
// the future host-adapters public probe. The auth adapter is the members
// tests/support/trusted-auth-double.mjs TEST DOUBLE, not a production account
// store. No secrets are recorded.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_CODES,
  createOrganizationService,
  createOrganizationStore,
  isTypedError,
} from '../../modules/organization/src/public/index.mjs';
import {
  MEMBER_ERROR_CODES,
  createBindingStore,
  createMembersService,
} from '../../modules/members/src/public/index.mjs';
import { createTrustedAuthDouble } from '../../modules/members/tests/support/trusted-auth-double.mjs';
import { createTmuxSessionProbe } from '../../modules/members/tests/support/tmux-session-probe.mjs';

const TOKENS = {
  owner: 'members-impl-owner',
  foreign: 'members-impl-foreign',
};

// Members test-local trusted auth double; TEST DOUBLE, not a production store.
const auth = createTrustedAuthDouble({
  accounts: {
    [TOKENS.owner]: { accountId: 'acct-owner', scopes: ['members:read', 'members:write'], workspaces: '*' },
    [TOKENS.foreign]: { accountId: 'acct-foreign', scopes: ['members:read', 'members:write'], workspaces: ['ws-foreign'] },
  },
});

const runDir = mkdtempSync(join(tmpdir(), 'zterm-members-impl-'));
const orgFile = join(runDir, 'organization.json');
const bindingFile = join(runDir, 'bindings.json');
const tmuxDir = join(runDir, 'tmux');
mkdirSync(tmuxDir, { recursive: true });
const tmuxSocket = join(tmuxDir, `socket-${process.pid}`);

const closeCommands = [];

function tmux(args) {
  return execFileSync('tmux', ['-S', tmuxSocket, ...args], { encoding: 'utf8' }).trim();
}

const createdSessions = [];

function startRealSession(name) {
  const sessionId = tmux(['new-session', '-d', '-s', name, '-c', runDir, '-P', '-F', '#{session_id}']);
  createdSessions.push(name);
  const paneId = tmux(['list-panes', '-t', name, '-F', '#{pane_id}']).split('\n')[0];
  return { sessionId, paneId, name };
}

function closeOwnSession(name) {
  closeCommands.push(`tmux -S ${tmuxSocket} kill-session -t ${name}`);
  tmux(['kill-session', '-t', name]);
}

async function capture(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isTypedError(error)) {
      return {
        ok: false,
        code: error.code,
        owningModule: error.owningModule,
        retryDisposition: error.retryDisposition,
        message: error.message,
      };
    }
    return { ok: false, code: 'UNEXPECTED', message: error?.message ?? String(error) };
  }
}

function readStore(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, bindings: {}, runtimeConfigs: {}, generations: {} };
    throw error;
  }
}

function afterSessions() {
  try {
    return { remainingSessions: tmux(['list-sessions', '-F', '#{session_name}']) };
  } catch (error) {
    return { remainingSessions: null, server: `exited: ${error.message.split('\n')[0]}` };
  }
}

const organization = createOrganizationService({ store: createOrganizationStore(orgFile), auth });
const workspace = await organization.createWorkspace({ token: TOKENS.owner, name: 'MembersImpl' });
const member = await organization.addMember({
  token: TOKENS.owner,
  workspaceId: workspace.workspaceId,
  groupId: workspace.rootGroupId,
  name: 'MemberImpl',
  machineId: 'mac-impl',
  hostKind: 'tmux',
  agentKind: 'codex',
  launchProfileRef: 'lp-impl',
});

const first = startRealSession(`zterm-members-impl-a-${process.pid}`);
const second = startRealSession(`zterm-members-impl-b-${process.pid}`);

const hostProbe = createTmuxSessionProbe({ socketPath: tmuxSocket });
const members = createMembersService({ store: createBindingStore(bindingFile), auth, organization, hostProbe });

const configured = await capture(() => members.configureRuntime({
  token: TOKENS.owner,
  memberId: member.memberId,
  machineId: 'mac-impl',
  hostKind: 'tmux',
  agentKind: 'codex',
  launchProfileRef: 'lp-impl',
}));
const queried = await capture(() => members.queryRuntime({ token: TOKENS.owner, memberId: member.memberId }));
const bound = await capture(() => members.bindSession({
  token: TOKENS.owner,
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 0,
}));
const advanced = await capture(() => members.bindSession({
  token: TOKENS.owner,
  memberId: member.memberId,
  sessionId: second.sessionId,
  anchor: second.paneId,
  expectedGeneration: 1,
}));
const stale = await capture(() => members.bindSession({
  token: TOKENS.owner,
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 1,
}));
const verifiedLive = await capture(() => members.verifyHost({ token: TOKENS.owner, memberId: member.memberId }));
const restoredLive = await capture(() => members.restoreBinding({ token: TOKENS.owner, memberId: member.memberId }));
const readerConsistent = await capture(() => members.getRuntimeBinding(member.memberId));

const storeBeforeDenied = readStore(bindingFile);
const crossWorkspace = await capture(() => members.queryRuntime({ token: TOKENS.foreign, memberId: member.memberId }));
const crossWorkspaceBind = await capture(() => members.bindSession({
  token: TOKENS.foreign,
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 2,
}));
const storeAfterDenied = readStore(bindingFile);

const runtimeChanged = await capture(() => members.configureRuntime({
  token: TOKENS.owner,
  memberId: member.memberId,
  machineId: 'mac-other',
  hostKind: 'tmux',
  agentKind: 'codex',
  launchProfileRef: 'lp-impl',
}));
const readerAfterChange = await capture(() => members.getRuntimeBinding(member.memberId));

await members.configureRuntime({
  token: TOKENS.owner,
  memberId: member.memberId,
  machineId: 'mac-impl',
  hostKind: 'tmux',
  agentKind: 'codex',
  launchProfileRef: 'lp-impl',
});
// The generation counter is monotonic across invalidation: the old
// expectedGeneration 0 path must be rejected, and the next valid bind advances
// to generation 3 instead of reissuing generation 1.
const reuseOldGeneration = await capture(() => members.bindSession({
  token: TOKENS.owner,
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 0,
}));
const rebound = await capture(() => members.bindSession({
  token: TOKENS.owner,
  memberId: member.memberId,
  sessionId: second.sessionId,
  anchor: second.paneId,
  expectedGeneration: 2,
}));

const reopened = createMembersService({ store: createBindingStore(bindingFile), auth, organization, hostProbe });
const reopenedRuntime = await capture(() => reopened.queryRuntime({ token: TOKENS.owner, memberId: member.memberId }));
const reopenedBinding = await capture(() => reopened.queryBinding({ token: TOKENS.owner, memberId: member.memberId }));

for (const name of [...createdSessions]) {
  closeOwnSession(name);
}

const unavailableVerify = await capture(() => members.verifyHost({ token: TOKENS.owner, memberId: member.memberId }));
const unavailableRestore = await capture(() => members.restoreBinding({ token: TOKENS.owner, memberId: member.memberId }));

const storesEqual = JSON.stringify(storeBeforeDenied) === JSON.stringify(storeAfterDenied);
const after = afterSessions();

const receipt = {
  kind: 'members-impl-real-tmux-self-check',
  publicEntry: 'v2/modules/members/src/public/index.mjs',
  authDouble: 'v2/modules/members/tests/support/trusted-auth-double.mjs (TEST DOUBLE, not a production account store)',
  hostProbe: 'v2/modules/members/tests/support/tmux-session-probe.mjs (test fixture, session/anchor only; no machine identity)',
  workspace: { branch: 'zterm-v2-members-1103' },
  realTmux: {
    first,
    second,
    socket: tmuxSocket,
    closeCommands,
    after,
  },
  member: { memberId: member.memberId, workspaceId: workspace.workspaceId },
  configured,
  queried,
  bound,
  advanced,
  stale,
  verifiedLive,
  restoredLive,
  readerConsistent,
  crossWorkspace,
  crossWorkspaceBind,
  storesEqual,
  runtimeChanged,
  readerAfterChange,
  reuseOldGeneration,
  rebound,
  reopenedRuntime,
  reopenedBinding,
  unavailableVerify,
  unavailableRestore,
  outcome:
    configured.ok
    && queried.ok && queried.value.machineId === 'mac-impl'
    && bound.ok && bound.value.generation === 1
    && advanced.ok && advanced.value.generation === 2
    && !stale.ok && stale.code === ERROR_CODES.BINDING_GENERATION_STALE
    && !verifiedLive.ok && verifiedLive.code === MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE
    && !restoredLive.ok && restoredLive.code === MEMBER_ERROR_CODES.BINDING_HOST_IDENTITY_UNAVAILABLE
    && readerConsistent.ok
    && readerConsistent.value.machineId === 'mac-impl'
    && readerConsistent.value.bindingGeneration === 2
    && !crossWorkspace.ok && crossWorkspace.code === MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_WORKSPACE
    && !crossWorkspaceBind.ok && crossWorkspaceBind.code === MEMBER_ERROR_CODES.MEMBER_FORBIDDEN_WORKSPACE
    && storesEqual
    && runtimeChanged.ok && runtimeChanged.value.machineId === 'mac-other'
    && !readerAfterChange.ok && readerAfterChange.code === MEMBER_ERROR_CODES.MEMBER_BINDING_NOT_FOUND
    && !reuseOldGeneration.ok && reuseOldGeneration.code === ERROR_CODES.BINDING_GENERATION_STALE
    && rebound.ok && rebound.value.generation === 3
    && reopenedRuntime.ok && reopenedRuntime.value.machineId === 'mac-impl'
    && reopenedBinding.ok && reopenedBinding.value.generation === 3
    && !unavailableVerify.ok && unavailableVerify.code === MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE
    && !unavailableRestore.ok && unavailableRestore.code === MEMBER_ERROR_CODES.BINDING_HOST_UNAVAILABLE
    && !after.remainingSessions
      ? 'PASS'
      : 'FAIL',
};

const outPath = process.argv[2] ?? join(import.meta.dirname, 'real-tmux-receipt.json');
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt, null, 2));
