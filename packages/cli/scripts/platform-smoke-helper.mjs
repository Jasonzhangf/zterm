import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';

export const SUPPORTED_TUPLES = new Set([
  'win32-x64',
  'linux-x64',
  'darwin-arm64',
]);

export function tupleOf(
  platform = process.platform,
  arch = process.arch,
) {
  return `${platform}-${arch}`;
}

export function assertSupportedTuple(
  platform = process.platform,
  arch = process.arch,
) {
  const tuple = tupleOf(platform, arch);
  if (!SUPPORTED_TUPLES.has(tuple)) {
    throw new Error(
      `unsupported platform tuple ${tuple}; expected one of ${[
        ...SUPPORTED_TUPLES,
      ].join(', ')}`,
    );
  }
  return tuple;
}

export function installedCliBin(
  prefix,
  platform = process.platform,
) {
  return platform === 'win32'
    ? join(prefix, 'zterm.cmd')
    : join(prefix, 'bin', 'zterm');
}

export function installedCliPackageRoot(
  prefix,
  platform = process.platform,
) {
  return platform === 'win32'
    ? join(prefix, 'node_modules', '@jsonstudio', 'zterm-cli')
    : join(prefix, 'lib', 'node_modules', '@jsonstudio', 'zterm-cli');
}

function quoteWindowsArg(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

export function formalCliInvocation(
  binPath,
  args,
  platform = process.platform,
  env = process.env,
) {
  if (platform !== 'win32') {
    return { command: binPath, args };
  }
  const commandLine = `${quoteWindowsArg(binPath)} ${
    args.map(quoteWindowsArg).join(' ')
  }`.trim();
  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

export function parsePlatformSmokeArgs(argv) {
  const options = {
    evidenceDir: resolve('platform-smoke-evidence'),
    timeoutMs: 30_000,
    daemonNativePath: undefined,
    daemonPackageRoot: undefined,
    skipBuild: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--evidence-dir') {
      const value = argv[++index];
      if (!value) throw new Error('--evidence-dir requires a value');
      options.evidenceDir = resolve(value);
      continue;
    }
    if (arg === '--timeout-ms') {
      const value = argv[++index];
      const timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000) {
        throw new Error('--timeout-ms must be an integer of at least 1000');
      }
      options.timeoutMs = timeoutMs;
      continue;
    }
    if (arg === '--daemon-native') {
      const value = argv[++index];
      if (!value) throw new Error('--daemon-native requires a value');
      options.daemonNativePath = resolve(value);
      continue;
    }
    if (arg === '--daemon-package-root') {
      const value = argv[++index];
      if (!value) throw new Error('--daemon-package-root requires a value');
      options.daemonPackageRoot = resolve(value);
      continue;
    }
    if (arg === '--skip-build') {
      options.skipBuild = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    throw new Error(`unknown platform smoke argument: ${arg}`);
  }

  return options;
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function findSingleFile(directory, suffix) {
  const matches = readdirSync(directory)
    .filter((entry) => entry.endsWith(suffix))
    .sort();
  if (matches.length !== 1) {
    throw new Error(
      `expected one ${suffix} file in ${directory}, found ${matches.length}`,
    );
  }
  return join(directory, matches[0]);
}

export function parseDaemonCompileResult(value) {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('DAGpipe native compilePhase0 returned no result');
  }
  if (parsed.ok !== true) {
    throw new Error(
      `DAGpipe native compilePhase0 failed: ${
        parsed.error || 'unknown error'
      }`,
    );
  }
  return parsed;
}

export function runProcess(
  command,
  args,
  {
    cwd,
    env = process.env,
    timeout = 120_000,
    allowFailure = false,
    input,
    windowsVerbatimArguments = false,
  } = {},
) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    timeout,
    input,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
    windowsVerbatimArguments,
    maxBuffer: 8 * 1024 * 1024,
  });
  const normalized = {
    command,
    args,
    exitCode: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error,
  };
  if (!allowFailure && (result.error || result.status !== 0)) {
    const detail = result.error?.message
      || result.stderr
      || result.stdout
      || 'process exited without details';
    throw new Error(
      `${basename(command)} failed with exit ${String(result.status)}: ${
        detail.trim()
      }`,
    );
  }
  return normalized;
}

export function resolveWrtcInstallation(
  installedPackageJson,
  platform = process.platform,
  arch = process.arch,
) {
  const tuple = assertSupportedTuple(platform, arch);
  const packageRequire = createRequire(installedPackageJson);
  const wrtcEntry = packageRequire.resolve('@roamhq/wrtc');
  const wrtcRequire = createRequire(wrtcEntry);
  const nativePath = wrtcRequire.resolve(
    `@roamhq/wrtc-${tuple}/wrtc.node`,
  );
  if (!existsSync(nativePath)) {
    throw new Error(`wrtc native binary is missing: ${nativePath}`);
  }
  return { wrtcEntry, nativePath, tuple };
}

export function resolveNodePtyInstallation(
  androidPackageJson,
  platform = process.platform,
  arch = process.arch,
) {
  const tuple = assertSupportedTuple(platform, arch);
  const packageRequire = createRequire(androidPackageJson);
  const entry = packageRequire.resolve('node-pty');
  const packageRoot = dirname(dirname(entry));
  const prebuildRoot = join(packageRoot, 'prebuilds', tuple);
  const nativeRoot = [
    join(packageRoot, 'build', 'Release'),
    join(packageRoot, 'build', 'Debug'),
    prebuildRoot,
  ].find((directory) => existsSync(join(directory, 'pty.node')));
  if (!nativeRoot) {
    throw new Error(
      `node-pty native binary is missing under ${packageRoot}; checked build/Release, build/Debug, and prebuilds/${tuple}`,
    );
  }
  const ptyNativePath = join(nativeRoot, 'pty.node');
  const conPtyNativePath = join(nativeRoot, 'conpty.node');
  if (platform === 'win32' && !existsSync(conPtyNativePath)) {
    throw new Error(`node-pty ConPTY binary is missing: ${conPtyNativePath}`);
  }
  return {
    entry,
    packageRoot,
    ptyNativePath,
    ptyNativeRelativePath: relative(packageRoot, ptyNativePath),
    spawnHelperRelativePath: relative(
      packageRoot,
      join(nativeRoot, 'spawn-helper'),
    ),
    ...(existsSync(conPtyNativePath) ? { conPtyNativePath } : {}),
    tuple,
  };
}

export function environmentSecrets(env = process.env) {
  return Object.entries(env)
    .filter(([name, value]) => (
      typeof value === 'string'
      && value.length >= 6
      && /(TOKEN|PASSWORD|SECRET|KEY)/iu.test(name)
    ))
    .map(([, value]) => value);
}

export function redactText(value, secrets = []) {
  let text = String(value);
  for (const secret of [...new Set(secrets)]
    .filter((candidate) => typeof candidate === 'string' && candidate.length >= 4)
    .sort((left, right) => right.length - left.length)) {
    text = text.replaceAll(secret, '[REDACTED]');
  }
  return text;
}

export function sanitizeValue(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry, secrets));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeValue(entry, secrets),
      ]),
    );
  }
  return value;
}

export function redactEvidenceDirectory(
  directory,
  secrets = environmentSecrets(),
) {
  const textExtensions = new Set([
    '.json',
    '.jsonl',
    '.log',
    '.md',
    '.out',
    '.txt',
  ]);
  const summary = {
    filesScanned: 0,
    filesRedacted: 0,
  };
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (!entry.isFile() || !statSync(path).isFile()) continue;
      const extension = entry.name.includes('.')
        ? entry.name.slice(entry.name.lastIndexOf('.'))
        : '';
      if (!textExtensions.has(extension)) continue;
      summary.filesScanned += 1;
      const original = readFileSync(path, 'utf8');
      const redacted = redactText(original, secrets);
      if (redacted === original) continue;
      writeFileSync(path, redacted);
      summary.filesRedacted += 1;
    }
  };
  visit(resolve(directory));
  return summary;
}
