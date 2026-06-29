import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildWezTermSendTextArgs } from '../src/server/wezterm-backend';

const DEFAULT_HOST = 'huawei@100.75.122.121';
const DEFAULT_EXE = 'D:\\zterm-tools\\wezterm\\portable\\WezTerm-windows-20240203-110809-5046fc22\\wezterm.exe';
const REMOTE_KEYPROBE_PATH = 'D:/zterm-tools/wezterm/zterm-keyprobe.js';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const host = readArg('host') || process.env.ZTERM_WEZTERM_REMOTE_HOST || DEFAULT_HOST;
const weztermExe = readArg('wezterm') || process.env.ZTERM_WEZTERM_EXE || DEFAULT_EXE;
const includeCodex = process.argv.includes('--include-codex');

const sshBaseArgs = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', host];

function ssh(command: string) {
  return execFileSync('ssh', [...sshBaseArgs, command], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function quoteRemoteArg(arg: string) {
  return /^[A-Za-z0-9:_./=\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`;
}

function runWezTerm(args: string[]) {
  const command = [`"${weztermExe}"`, ...args.map(quoteRemoteArg)].join(' ');
  return ssh(command);
}

function sendInput(paneId: number, payload: Buffer | string) {
  const command = [`"${weztermExe}"`, ...buildWezTermSendTextArgs(paneId).map(quoteRemoteArg)].join(' ');
  const result = spawnSync('ssh', [...sshBaseArgs, command], {
    input: payload,
    encoding: typeof payload === 'string' ? 'utf8' : undefined,
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`send-text failed for pane ${paneId}: ${result.stderr || result.stdout}`);
  }
}

function pickLastNumber(output: string) {
  const matches = output.match(/\b\d+\b/g);
  if (!matches?.length) {
    throw new Error(`wezterm spawn did not return a pane id: ${output}`);
  }
  return Number.parseInt(matches[matches.length - 1]!, 10);
}

function spawnPane(workspace: string, command: string[]) {
  return pickLastNumber(runWezTerm([
    'cli',
    '--prefer-mux',
    'spawn',
    '--new-window',
    '--workspace',
    workspace,
    '--',
    ...command,
  ]));
}

function getText(paneId: number) {
  return runWezTerm([
    'cli',
    '--prefer-mux',
    'get-text',
    '--pane-id',
    String(paneId),
    '--start-line',
    '-80',
    '--end-line',
    '80',
    '--escapes',
  ]);
}

function killPane(paneId: number) {
  runWezTerm(['cli', '--prefer-mux', 'kill-pane', '--pane-id', String(paneId)]);
}

function assertIncludes(value: string, expected: string, label: string) {
  if (!value.includes(expected)) {
    throw new Error(`${label} missing ${expected}\n--- text ---\n${value}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function verifyCmdEditing() {
  const paneId = spawnPane('zterm-input-cmd', ['cmd.exe', '/k', 'echo ZTERM_INPUT_READY']);
  try {
    await sleep(1000);
    sendInput(paneId, 'echo ZTERM_INPUT_ENTER_OK\r');
    sendInput(paneId, Buffer.from('echo BAD\x7fOK\r', 'binary'));
    sendInput(paneId, Buffer.from('echo ZTERM_ARROW_HISTORY\r\x1b[A\r', 'binary'));
    await sleep(1000);
    const text = getText(paneId);
    assertIncludes(text, 'ZTERM_INPUT_ENTER_OK', 'cmd enter');
    assertIncludes(text, 'BAOK', 'cmd backspace');
    const historyMatches = text.match(/ZTERM_ARROW_HISTORY/g) || [];
    if (historyMatches.length < 4) {
      throw new Error(`cmd arrow history did not replay command\n--- text ---\n${text}`);
    }
    return { paneId, ok: true };
  } finally {
    killPane(paneId);
  }
}

function uploadKeyProbe() {
  const tmp = mkdtempSync(join(tmpdir(), 'zterm-wezterm-input-'));
  const localPath = join(tmp, 'zterm-keyprobe.js');
  writeFileSync(localPath, `
process.stdin.setRawMode(true);
process.stdin.resume();
console.log('ZTERM_KEYPROBE_READY');
process.stdin.on('data', (buf) => {
  console.log('KEY:' + Buffer.from(buf).toString('hex'));
});
`, 'utf8');
  const result = spawnSync('scp', [
    '-q',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    localPath,
    `${host}:${REMOTE_KEYPROBE_PATH}`,
  ], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`failed to upload keyprobe: ${result.stderr || result.stdout}`);
  }
}

async function verifyRawTuiBytes() {
  uploadKeyProbe();
  const paneId = spawnPane('zterm-input-raw', ['cmd.exe', '/k', 'node', REMOTE_KEYPROBE_PATH.replace(/\//g, '\\')]);
  try {
    await sleep(1000);
    sendInput(paneId, Buffer.from([0x1b, 0x7f, 0x1b, 0x5b, 0x41, 0x03]));
    await sleep(1000);
    const text = getText(paneId);
    assertIncludes(text, 'ZTERM_KEYPROBE_READY', 'raw keyprobe');
    assertIncludes(text, 'KEY:1b7f1b5b4103', 'raw control bytes');
    return { paneId, ok: true };
  } finally {
    killPane(paneId);
  }
}

async function verifyCodexTextEntry() {
  const paneId = spawnPane('zterm-input-codex', ['cmd.exe', '/c', 'codex']);
  try {
    await sleep(4000);
    sendInput(paneId, 'ZTERM_CODEX_INPUT_PROBE');
    await sleep(1000);
    const text = getText(paneId);
    assertIncludes(text, 'ZTERM_CODEX_INPUT_PROBE', 'codex text entry');
    return { paneId, ok: true };
  } finally {
    killPane(paneId);
  }
}

async function main() {
  const version = ssh(`"${weztermExe}" --version`).trim();
  assertIncludes(version, 'wezterm', 'version');

  const cmd = await verifyCmdEditing();
  const raw = await verifyRawTuiBytes();
  const codex = includeCodex ? await verifyCodexTextEntry() : null;

  console.log(JSON.stringify({
    ok: true,
    host,
    version,
    inputContract: {
      mode: 'send-text-no-paste-stdin',
      cmd,
      raw,
      codex,
      knownLimitation: 'ETX reaches raw-mode apps, but does not act as a Windows console Ctrl+C event for cmd.exe child processes such as ping -t.',
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
