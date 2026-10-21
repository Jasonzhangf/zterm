#!/usr/bin/env node

import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const realTmux = String(process.env.CLI_BLACKBOX_REAL_TMUX || '').trim();
const ownSocket = String(process.env.CLI_BLACKBOX_TMUX_SOCKET || '').trim();
const ownSession = String(process.env.CLI_BLACKBOX_TMUX_SESSION || '').trim();
const auditLog = String(process.env.CLI_BLACKBOX_TMUX_AUDIT_LOG || '').trim();

function fail(message) {
  process.stderr.write(`[cli-blackbox-tmux] ${message}\n`);
  process.exit(64);
}

function audit(status, args) {
  if (!auditLog) {
    return;
  }
  try {
    appendFileSync(
      auditLog,
      `${JSON.stringify({ at: new Date().toISOString(), status, args })}\n`,
      'utf8',
    );
  } catch {
    // The audit log is diagnostic only and must not alter tmux behavior.
  }
}

if (!realTmux || !ownSocket || !ownSession) {
  fail('missing real tmux, owned socket, or owned session');
}

const rawArgs = process.argv.slice(2);
let args = rawArgs;

if (args[0] === '-L') {
  audit('rejected', rawArgs);
  fail('named tmux sockets are not allowed');
}

if (args[0] === '-S') {
  if (args[1] !== ownSocket) {
    audit('rejected', rawArgs);
    fail(`foreign tmux socket rejected: ${args[1] || '(missing)'}`);
  }
  args = args.slice(2);
}

const command = args[0] || '';
if (!command || command.startsWith('-')) {
  audit('rejected', rawArgs);
  fail('tmux command must be the first non-socket argument');
}

if (command === 'kill-server') {
  audit('rejected', rawArgs);
  fail('kill-server is forbidden');
}

if (command === 'kill-session') {
  const targetIndex = args.indexOf('-t');
  const target = targetIndex >= 0 ? args[targetIndex + 1] || '' : '';
  const exactOwnName = target === ownSession || target === `=${ownSession}`;
  if (!exactOwnName || args.includes('-a')) {
    audit('rejected', rawArgs);
    fail(`kill-session is limited to the owned session ${ownSession}`);
  }
}

const nestedCommands = new Set([
  'bind-key',
  'command-prompt',
  'confirm-before',
  'if-shell',
  'run-shell',
  'set-hook',
  'source-file',
  'unbind-key',
]);
if (nestedCommands.has(command)) {
  audit('rejected', rawArgs);
  fail(`${command} could bypass isolated lifecycle guards`);
}

const result = spawnSync(realTmux, ['-S', ownSocket, ...args], {
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  audit('spawn-error', rawArgs);
  process.stderr.write(`[cli-blackbox-tmux] ${result.error.message}\n`);
  process.exit(1);
}

audit(result.status === 0 ? 'allowed' : 'command-failed', rawArgs);
process.exit(result.status === null ? 1 : result.status);
