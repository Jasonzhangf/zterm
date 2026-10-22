import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { InteractivePtyShell, cliCommand } from './remote-cli-blackbox.mjs';

if (process.platform !== 'win32') throw new Error('native Windows is required');
const options = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  if (!['--pty-package-root', '--evidence-dir'].includes(process.argv[i]) || !process.argv[i + 1]) {
    throw new Error('expected --pty-package-root and --evidence-dir');
  }
  options.set(process.argv[i], resolve(process.argv[i + 1]));
}
if (options.size !== 2) throw new Error('both input paths are required');
const root = mkdtempSync(join(tmpdir(), 'zterm-console-observe-'));
const evidenceDir = options.get('--evidence-dir');
mkdirSync(evidenceDir, { recursive: true });
const ptyRoot = options.get('--pty-package-root');
const requirePty = createRequire(join(ptyRoot, 'package.json'));
const pty = requirePty(ptyRoot);
const fixture = join(root, 'interrupt.cjs');
writeFileSync(fixture, `
const stdin = process.stdin;
process.on('SIGINT', () => process.stdout.write('OBSERVED_SIGINT:' + process.pid + '\\r\\n', () => process.exit(130)));
if (process.argv[2] === 'resume') {
  stdin.on('data', bytes => process.stdout.write('INPUT_HEX:' + bytes.toString('hex') + '\\r\\n'));
  stdin.resume();
}
process.stdout.write('READY_PID:' + process.pid + '\\r\\n');
setInterval(() => {}, 1000);
`);

function alive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}
async function waitFor(predicate, milliseconds) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

const cases = [];
let cleanupComplete = true;
try {
  for (const interactive of [false, true]) {
    for (const resume of [false, true]) {
      const result = { interactive, resume, startedAt: new Date().toISOString() };
      let shell;
      let fakePid;
      let terminalPid;
      try {
        const env = { ...process.env, ZTERM_REMOTE_NODE: process.execPath, ZTERM_REMOTE_CLI: fixture };
        if (interactive) {
          shell = await InteractivePtyShell.start({ pty, cwd: root, env });
          shell.sendLine(cliCommand(fixture, [resume ? 'resume' : 'idle'], 'win32'));
        } else {
          const terminal = pty.spawn(process.execPath, [fixture, resume ? 'resume' : 'idle'], {
            name: 'xterm-256color', cols: 120, rows: 36, cwd: root, env, useConpty: true,
          });
          shell = new InteractivePtyShell(terminal, '', 'win32');
        }
        terminalPid = shell.terminal.pid;
        if (!interactive) fakePid = terminalPid;
        result.terminalPid = terminalPid;
        const ready = await waitFor(() => /READY_PID:(\d+)/.test(shell.output), 5000);
        if (!ready) throw new Error('fake CLI did not become ready');
        fakePid = Number(/READY_PID:(\d+)/.exec(shell.output)[1]);
        result.fakePid = fakePid;
        result.readyAt = new Date().toISOString();
        shell.write('\x03');
        result.stimulusAt = new Date().toISOString();
        result.signalObservedBeforeCleanup = await waitFor(
          () => shell.output.includes(`OBSERVED_SIGINT:${fakePid}`), 3000,
        );
        result.actualFakeExitedBeforeCleanup = await waitFor(() => !alive(fakePid), 1000);
        result.ptyExitEventBeforeCleanup = shell.closed;
      } catch (error) {
        result.error = error.message;
      } finally {
        result.forcedFakeKill = false;
        result.forcedPtyKill = false;
        if (fakePid && alive(fakePid)) {
          result.forcedFakeKill = true;
          process.kill(fakePid, 'SIGKILL');
          await waitFor(() => !alive(fakePid), 2000);
        }
        if (shell && !shell.closed) {
          if (interactive) shell.sendLine('exit');
          await waitFor(() => shell.closed, 1000);
          if (!shell.closed) {
            result.forcedPtyKill = true;
            try { shell.terminal.kill(); } catch (error) { result.ptyCloseError = error.message; }
            await waitFor(() => shell.closed, 1000);
          }
        }
        if (terminalPid && alive(terminalPid)) {
          result.forcedPtyKill = true;
          process.kill(terminalPid, 'SIGKILL');
          await waitFor(() => !alive(terminalPid), 2000);
        }
        result.output = shell?.output ?? '';
        result.cleanup = {
          fakeGone: fakePid ? !alive(fakePid) : !interactive,
          terminalGone: !terminalPid || !alive(terminalPid),
        };
        cleanupComplete &&= result.cleanup.fakeGone && result.cleanup.terminalGone;
        cases.push(result);
        writeFileSync(join(evidenceDir, 'windows-interrupt-observation.json'), JSON.stringify({
          coverage: 'console-stimulus-observation', acceptance: false, cases, cleanupComplete,
        }, null, 2));
      }
    }
  }
} finally {
  if (cleanupComplete) rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ cases: cases.map(({ interactive, resume, signalObservedBeforeCleanup, actualFakeExitedBeforeCleanup, error }) => ({
  interactive, resume, signalObservedBeforeCleanup, actualFakeExitedBeforeCleanup, error,
})), cleanupComplete }) + '\n', () => process.exit(cleanupComplete ? 0 : 1));
