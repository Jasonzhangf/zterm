import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ANDROID_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEST_FILE_PATTERN = /(?:^|\/)([^/\s]+\.test\.(?:mjs|ts|tsx))$/u;

export const PREBUILD_GATE_SCRIPTS = Object.freeze([
  'test:build-version',
  'test:traversal',
  'test:android-connection-service',
  'test:android-network-identity',
  'test:feature-registry',
  'test:shared-contract-ownership',
  'test:debug-observability',
  'test:runtime-architecture-v2',
  'test:plugin-host',
  'test:low-risk-plugin-ui',
  'test:debug-console-ui',
  'test:session-drawer-ui',
  'test:file-browser-ui',
  'test:settings-update-ui',
  'test:settings-connection-config',
  'test:remote-window-ui',
  'test:quickbar-ui',
  'test:terminal-shell-ui',
  'test:composition-root',
  'test:control-center',
  'test:daemon-control-center',
  'test:daemon-buffer-publisher',
  'test:daemon-session-catalog',
  'test:attachment-message-delivery',
  'test:file-transfer-message-route',
  'test:source-adapter-ownership',
  'test:mirror-writer-ownership',
  'test:input-normalizer',
  'test:reliable-input-ownership',
  'test:daemon-input-queue',
  'test:terminal-channel-mux',
  'test:session-input-runtime',
  'test:terminal:shell-theme',
  'test:file-transfer:throughput',
  'test:transport-network-lifecycle',
  'test:terminal:regression:core',
  'test:relay:account-directory',
  'test:workspace:panes',
]);

export const CI_ONLY_GATE_SCRIPTS = Object.freeze([
  'test:android-connection-service:native',
  'test:terminal:frame-assembly',
  'test:redline:fast',
  'test:remote-screenshot-regression',
]);

function splitShellCommands(script) {
  return script
    .split(/\s*(?:&&|;)\s*/u)
    .map((command) => command.trim())
    .filter(Boolean);
}

function parseVitestCommand(command) {
  const match = command.match(/^pnpm(?:\s+--dir\s+(\S+))?\s+exec\s+vitest\s+run\s+(.+)$/u);
  if (!match) return null;

  const workingDirectory = match[1] ?? '.';
  const tokens = match[2].split(/\s+/u).filter(Boolean);
  const files = tokens.filter((token) => TEST_FILE_PATTERN.test(token));
  if (files.length === 0) return null;

  return {
    kind: 'vitest',
    command,
    workingDirectory,
    files,
    options: tokens.filter((token) => !files.includes(token)),
  };
}

function normalizeTestFile(file) {
  return file.replace(/^\.\//u, '');
}

function sourceDetails(command, androidRoot) {
  const sourceMatch = command.match(/(?:node|bash|sh|tsx)\s+(?:\.\/)?([^\s;&]+\.(?:mjs|js|sh|ts))\b/u);
  if (!sourceMatch) return null;

  const sourcePath = resolve(androidRoot, sourceMatch[1]);
  if (!existsSync(sourcePath)) return null;
  return { sourcePath, source: readFileSync(sourcePath, 'utf8') };
}

function sourceTestFiles(command, androidRoot) {
  const details = sourceDetails(command, androidRoot);
  if (!details) return [];

  const files = [];
  const pattern = /((?:\.\.\/packages\/shared\/)?(?:src|scripts)\/[A-Za-z0-9_./:@-]+\.test\.(?:tsx|mjs|ts))(?![A-Za-z0-9])/gu;
  for (const match of details.source.matchAll(pattern)) files.push(normalizeTestFile(match[1]));
  return [...new Set(files)];
}

function sourceVitestCommand(command, androidRoot) {
  const details = sourceDetails(command, androidRoot);
  if (!details || !details.source.includes('vitest')) return null;

  const files = sourceTestFiles(command, androidRoot);
  if (files.length === 0 || !details.source.includes('spawnSync')) return null;
  return {
    kind: 'vitest',
    command,
    owner: null,
    workingDirectory: '.',
    files,
    options: details.source.includes('no-file-parallelism') ? ['--no-file-parallelism'] : [],
  };
}

function directTestFiles(command) {
  return command
    .split(/\s+/u)
    .filter((token) => TEST_FILE_PATTERN.test(token))
    .map(normalizeTestFile);
}

function collectCommands({ scripts, gateNames, androidRoot = ANDROID_ROOT }) {
  const commands = [];
  const visiting = new Set();

  function visit(name) {
    if (visiting.has(name)) throw new Error(`Android gate script cycle: ${name}`);
    const script = scripts[name];
    if (typeof script !== 'string') throw new Error(`Android gate script is missing: ${name}`);

    visiting.add(name);
    for (const command of splitShellCommands(script)) {
      const nested = command.match(/^pnpm(?:\s+--dir\s+\S+)?\s+run\s+(\S+)$/u);
      if (nested && Object.hasOwn(scripts, nested[1])) {
        visit(nested[1]);
        continue;
      }

      const vitest = parseVitestCommand(command);
      if (vitest) {
        commands.push({ ...vitest, owner: name });
        continue;
      }

      const sourceVitest = sourceVitestCommand(command, androidRoot);
      if (sourceVitest) {
        commands.push({ ...sourceVitest, owner: name });
        continue;
      }

      commands.push({
        kind: 'command',
        command,
        owner: name,
        files: [...new Set([...directTestFiles(command), ...sourceTestFiles(command, androidRoot)])],
      });
    }
    visiting.delete(name);
  }

  for (const name of gateNames) visit(name);
  return commands;
}

function fileKey(workingDirectory, file) {
  return `${workingDirectory}:${normalizeTestFile(file)}`;
}

export function collectGatePlan({
  scripts,
  gateNames = PREBUILD_GATE_SCRIPTS,
  androidRoot = ANDROID_ROOT,
} = {}) {
  const commands = collectCommands({ scripts, gateNames, androidRoot });
  const reserved = new Map();
  const inventory = new Map();

  for (const command of commands) {
    const workingDirectory = command.workingDirectory ?? '.';
    for (const file of command.files) {
      const key = fileKey(workingDirectory, file);
      const owners = inventory.get(key) ?? [];
      owners.push(command.owner);
      inventory.set(key, owners);
      if (command.kind === 'command' && !reserved.has(key)) reserved.set(key, command.owner);
    }
  }

  const emitted = new Set();
  const plan = [];
  for (const command of commands) {
    if (command.kind === 'command') {
      plan.push(command);
      continue;
    }

    const files = command.files
      .map(normalizeTestFile)
      .filter((file) => {
        const key = fileKey(command.workingDirectory, file);
        if (reserved.has(key) || emitted.has(key)) return false;
        emitted.add(key);
        return true;
      });
    if (files.length > 0) plan.push({ ...command, files });
  }

  const duplicates = [...inventory.entries()]
    .filter(([, owners]) => owners.length > 1)
    .map(([key, owners]) => ({ file: key, owners: [...new Set(owners)] }));

  return { plan, inventory, duplicates };
}

function shellCommandForPlanItem(item) {
  if (item.kind === 'command') return item.command;
  const prefix = item.workingDirectory === '.'
    ? 'pnpm exec vitest run'
    : `pnpm --dir ${item.workingDirectory} exec vitest run`;
  return [prefix, ...item.files, ...item.options].join(' ');
}

function runCommand(command, androidRoot) {
  return spawnSync('sh', ['-c', command], { cwd: androidRoot, stdio: 'inherit' });
}

export function runPrebuildGates({
  profile = 'prebuild',
  packageJson,
  gateNames: selectedGateNames,
  androidRoot = ANDROID_ROOT,
  run = runCommand,
  write = (line) => console.error(line),
} = {}) {
  const scripts = packageJson?.scripts;
  if (!scripts) throw new Error('Android package scripts are required');
  const gateNames = selectedGateNames ?? (profile === 'ci'
    ? [...PREBUILD_GATE_SCRIPTS, ...CI_ONLY_GATE_SCRIPTS]
    : [...PREBUILD_GATE_SCRIPTS]);
  const { plan, duplicates } = collectGatePlan({ scripts, gateNames, androidRoot });
  const failures = [];

  write(`Android ${profile} gate inventory: ${duplicates.length} duplicate file references assigned to one owner`);
  for (const duplicate of duplicates) {
    write(`- ${duplicate.file}: ${duplicate.owners.join(' -> ')}`);
  }

  for (const item of plan) {
    const command = shellCommandForPlanItem(item);
    const result = run(command, androidRoot);
    const status = typeof result?.status === 'number' ? result.status : 1;
    if (status !== 0) failures.push({ owner: item.owner, command, status });
  }

  if (failures.length === 0) {
    write(`Android ${profile} gates passed (${plan.length} commands)`);
    return 0;
  }

  write(`Android ${profile} gate failures (${failures.length}/${plan.length}):`);
  for (const failure of failures) write(`- ${failure.owner}: exit ${failure.status}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const packageJson = JSON.parse(readFileSync(join(ANDROID_ROOT, 'package.json'), 'utf8'));
  const profileIndex = process.argv.indexOf('--profile');
  const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : 'prebuild';
  process.exitCode = runPrebuildGates({ profile, packageJson });
}
