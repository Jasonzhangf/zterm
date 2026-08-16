import { execFileSync, spawnSync } from 'node:child_process';
import { buildWezTermMirrorSnapshot, parseWezTermPaneList } from '../src/server/wezterm-backend';

const DEFAULT_HOST = 'huawei@100.75.122.121';
const DEFAULT_EXE = 'D:\\zterm-tools\\wezterm\\portable\\WezTerm-windows-20240203-110809-5046fc22\\wezterm.exe';

function readArg(name: string) {
  const prefix = `--${name}=`;
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

const host = readArg('host') || process.env.ZTERM_WEZTERM_REMOTE_HOST || DEFAULT_HOST;
const weztermExe = readArg('wezterm') || process.env.ZTERM_WEZTERM_EXE || DEFAULT_EXE;

function ssh(command: string) {
  return execFileSync('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    host,
    command,
  ], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
}

function runWezTerm(args: string[]) {
  const command = [
    `"${weztermExe}"`,
    ...args.map((arg) => (/^[A-Za-z0-9:_./=-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`)),
  ].join(' ');
  return ssh(command);
}

function pickLastNumber(output: string) {
  const matches = output.match(/\b\d+\b/g);
  if (!matches?.length) {
    throw new Error(`wezterm spawn did not return a pane id: ${output}`);
  }
  return Number.parseInt(matches[matches.length - 1]!, 10);
}

function assertIncludes(value: string, expected: string, label: string) {
  if (!value.includes(expected)) {
    throw new Error(`${label} missing ${expected}`);
  }
}

async function main() {
  const version = ssh(`"${weztermExe}" --version`).trim();
  assertIncludes(version, 'wezterm', 'version');

  const paneId = pickLastNumber(runWezTerm([
    'cli',
    '--prefer-mux',
    'spawn',
    '--new-window',
    '--workspace',
    'zterm-smoke',
    '--',
    'cmd.exe',
    '/k',
    'echo ZTERM_WEZTERM_REMOTE_SMOKE',
  ]));

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const listOutput = runWezTerm(['cli', '--prefer-mux', 'list']);
  const panes = parseWezTermPaneList(listOutput);
  const pane = panes.find((candidate) => candidate.paneId === paneId);
  if (!pane) {
    throw new Error(`spawned pane ${paneId} is not listed by wezterm cli`);
  }

  const textEscapes = runWezTerm([
    'cli',
    '--prefer-mux',
    'get-text',
    '--pane-id',
    String(paneId),
    '--start-line',
    '-20',
    '--end-line',
    '20',
    '--escapes',
  ]);
  assertIncludes(textEscapes, 'ZTERM_WEZTERM_REMOTE_SMOKE', 'get-text');

  const snapshot = await buildWezTermMirrorSnapshot({
    pane,
    revision: 1,
    getTextEscapes: textEscapes,
  });
  const visibleText = snapshot.bufferLines
    .map((row) => row.map((cell) => String.fromCodePoint(cell.char)).join(''))
    .join('\n');
  assertIncludes(visibleText, 'ZTERM_WEZTERM_REMOTE_SMOKE', 'snapshot');

  const kill = spawnSync('ssh', [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=8',
    host,
    `"${weztermExe}" cli --prefer-mux kill-pane --pane-id ${paneId}`,
  ], { encoding: 'utf8' });
  if (kill.status !== 0) {
    throw new Error(`failed to cleanup wezterm pane ${paneId}: ${kill.stderr || kill.stdout}`);
  }

  console.log(JSON.stringify({
    ok: true,
    host,
    version,
    paneId,
    snapshot: {
      revision: snapshot.revision,
      bufferStartIndex: snapshot.bufferStartIndex,
      lineCount: snapshot.bufferLines.length,
      cols: snapshot.cols,
      rows: snapshot.rows,
    },
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
