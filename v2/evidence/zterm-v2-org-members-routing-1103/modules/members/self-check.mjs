// Owner self-check for the members module. Uses only the public organization
// reader and the public members entry. Binds real tmux sessions created on a
// dedicated, disposable socket inside the LayerFS workspace.

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ERROR_CODES,
  createDevVerifiedAuth,
  createOrganizationService,
  createOrganizationStore,
  isTypedError,
} from '../../../../modules/organization/src/public/index.mjs';
import {
  createBindingStore,
  createMembersService,
} from '../../../../modules/members/src/public/index.mjs';

const token = 'members-self-check-token';
const auth = createDevVerifiedAuth({
  accounts: { [token]: { accountId: 'acct-members-self-check', scopes: ['members:write'] } },
});

const runDir = mkdtempSync(join(tmpdir(), 'zterm-members-self-check-'));
const orgFile = join(runDir, 'organization.json');
const bindingFile = join(runDir, 'bindings.json');
const tmuxDir = join(runDir, 'tmux');
mkdirSync(tmuxDir, { recursive: true });
const tmuxSocket = join(tmuxDir, `socket-${process.pid}`);

function tmux(args) {
  return execFileSync('tmux', ['-S', tmuxSocket, ...args], { encoding: 'utf8' }).trim();
}

async function capture(fn) {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    if (isTypedError(error)) {
      return { ok: false, code: error.code, owningModule: error.owningModule, message: error.message };
    }
    return { ok: false, code: 'UNEXPECTED', message: error?.message ?? String(error) };
  }
}

const startedSessions = [];
function startRealSession(name) {
  const sessionId = tmux(['new-session', '-d', '-s', name, '-c', runDir, '-P', '-F', '#{session_id}']);
  startedSessions.push(name);
  const paneId = tmux(['list-panes', '-t', name, '-F', '#{pane_id}']).split('\n')[0];
  const created = tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}'])
    .split('\n')
    .find((line) => line.startsWith(`${name}\t`))
    ?.split('\t')[1] ?? null;
  return { sessionId, paneId, name, created };
}

function stopSessions() {
  for (const name of startedSessions) {
    try {
      tmux(['kill-session', '-t', name]);
    } catch {
      // Session already gone; keep evidence intact.
    }
  }
}

function after() {
  let remaining = null;
  try {
    remaining = tmux(['list-sessions', '-F', '#{session_name}']);
  } catch (error) {
    remaining = `server exited: ${error.message.split('\n')[0]}`;
  }
  return remaining;
}

const organization = createOrganizationService({ store: createOrganizationStore(orgFile), auth });
const workspace = await organization.createWorkspace({ token, name: 'MembersEvidence' });
const member = await organization.addMember({
  token,
  workspaceId: workspace.workspaceId,
  groupId: workspace.rootGroupId,
  name: 'MemberSelfCheck',
  machineId: 'self-check-machine',
  hostKind: 'tmux',
  agentKind: 'codex',
  launchProfileRef: 'lp-self-check',
});

const first = startRealSession(`zterm-members-a-${process.pid}`);
const second = startRealSession(`zterm-members-b-${process.pid}`);

const members = createMembersService({ store: createBindingStore(bindingFile), auth, organization });

const bound = await capture(() => members.bindSession({
  token,
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 0,
}));

const advanced = await capture(() => members.bindSession({
  token,
  memberId: member.memberId,
  sessionId: second.sessionId,
  anchor: second.paneId,
  expectedGeneration: 1,
}));

const stale = await capture(() => members.bindSession({
  token,
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 1,
}));

const unauthenticated = await capture(() => members.bindSession({
  token: 'wrong-token',
  memberId: member.memberId,
  sessionId: first.sessionId,
  anchor: first.paneId,
  expectedGeneration: 2,
}));

const reopened = createMembersService({ store: createBindingStore(bindingFile), auth, organization });
const persisted = await capture(() => reopened.queryBinding({ token, memberId: member.memberId }));

stopSessions();

const receipt = {
  kind: 'members-owner-self-check',
  publicEntry: 'v2/modules/members/src/public/index.mjs',
  workspace: {
    branch: 'zterm-v2-organization-1103',
    note: 'LayerFS branch identity comes from sandbox list_workspaces; git inside may report main.',
  },
  realTmux: { first, second, remainingAfterCleanup: after() },
  member: { memberId: member.memberId, workspaceId: workspace.workspaceId },
  bound,
  advanced,
  stale,
  unauthenticated,
  persisted,
  outcome:
    bound.ok && bound.value.generation === 1
    && advanced.ok && advanced.value.generation === 2
    && !stale.ok && stale.code === ERROR_CODES.BINDING_GENERATION_STALE
    && !unauthenticated.ok && unauthenticated.code === ERROR_CODES.UNAUTHENTICATED
    && persisted.ok && persisted.value.generation === 2
    && persisted.value.sessionId === second.sessionId
      ? 'PASS'
      : 'FAIL',
};

const outPath = process.argv[2] ?? join(import.meta.dirname, 'members-receipt.json');
writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(receipt, null, 2));
