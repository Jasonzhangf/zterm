// Test-owned tmux probe for members self-checks. It proves that the bound
// session and anchor still exist. It deliberately does not claim a machine
// identity: authoritative identity belongs to the future host-adapters probe.

import { execFile } from 'node:child_process';

function defaultExec(socketPath, args) {
  return new Promise((resolve, reject) => {
    execFile('tmux', ['-S', socketPath, ...args], { encoding: 'utf8' }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export function createTmuxSessionProbe({ socketPath, exec = defaultExec } = {}) {
  if (typeof socketPath !== 'string' || socketPath.length === 0) {
    throw new TypeError('tmux host probe requires a socketPath');
  }

  async function probe({ sessionId, anchor } = {}) {
    const observedAt = new Date().toISOString();
    try {
      const paneOutput = await exec(socketPath, ['list-panes', '-t', sessionId, '-F', '#{pane_id}']);
      const paneIds = paneOutput.split('\n').map((line) => line.trim()).filter(Boolean);
      const anchorPresent = anchor ? paneIds.includes(anchor) : false;
      return {
        available: true,
        machineId: null,
        sessionId,
        anchor,
        anchorPresent,
        observedAt,
      };
    } catch (error) {
      return {
        available: false,
        machineId: null,
        sessionId: sessionId ?? null,
        anchor: anchor ?? null,
        anchorPresent: false,
        observedAt,
        errorCode: error?.code ?? null,
      };
    }
  }

  return Object.freeze({ probe });
}
