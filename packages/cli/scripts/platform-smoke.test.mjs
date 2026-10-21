import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertSupportedTuple,
  findSingleFile,
  formalCliInvocation,
  installedCliBin,
  parseDaemonCompileResult,
  parsePlatformSmokeArgs,
  redactEvidenceDirectory,
  redactText,
  resolveNodePtyInstallation,
  resolveWrtcInstallation,
  sanitizeValue,
} from './platform-smoke-helper.mjs';

const scriptDir = fileURLToPath(new URL('.', import.meta.url));
const packageDir = resolve(scriptDir, '..');
const repoRoot = resolve(packageDir, '..', '..');

test('accepts only the reviewed platform tuples', () => {
  assert.equal(assertSupportedTuple('win32', 'x64'), 'win32-x64');
  assert.equal(assertSupportedTuple('linux', 'x64'), 'linux-x64');
  assert.equal(assertSupportedTuple('darwin', 'arm64'), 'darwin-arm64');
  assert.throws(
    () => assertSupportedTuple('darwin', 'x64'),
    /unsupported platform tuple darwin-x64/u,
  );
  assert.throws(
    () => assertSupportedTuple('linux', 'arm64'),
    /unsupported platform tuple linux-arm64/u,
  );
});

test('resolves the installed formal bin for Unix and Windows prefixes', () => {
  assert.equal(
    installedCliBin('/tmp/prefix', 'linux'),
    '/tmp/prefix/bin/zterm',
  );
  assert.equal(
    installedCliBin('/tmp/prefix', 'darwin'),
    '/tmp/prefix/bin/zterm',
  );
  assert.match(
    installedCliBin('C:\\npm', 'win32'),
    /zterm\.cmd$/u,
  );
});

test('invokes the Windows npm shim through cmd.exe', () => {
  const invocation = formalCliInvocation(
    'C:\\isolated prefix\\zterm.cmd',
    ['--version'],
    'win32',
    { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  );
  assert.equal(invocation.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(invocation.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.match(invocation.args[3], /zterm\.cmd/u);
  assert.match(invocation.args[3], /--version/u);
});

test('parses bounded smoke arguments and rejects unknown input', () => {
  const parsed = parsePlatformSmokeArgs([
    '--evidence-dir',
    './evidence',
    '--timeout-ms',
    '45000',
    '--daemon-native',
    './dagpipe.node',
    '--daemon-package-root',
    './daemon-platform',
    '--skip-build',
  ]);
  assert.equal(parsed.evidenceDir, resolve('./evidence'));
  assert.equal(parsed.timeoutMs, 45_000);
  assert.equal(parsed.daemonNativePath, resolve('./dagpipe.node'));
  assert.equal(parsed.daemonPackageRoot, resolve('./daemon-platform'));
  assert.equal(parsed.skipBuild, true);
  assert.throws(
    () => parsePlatformSmokeArgs(['--unknown']),
    /unknown platform smoke argument/u,
  );
});

test('finds one package artifact and rejects ambiguity', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-smoke-helper-'));
  try {
    writeFileSync(join(directory, 'zterm-cli-0.1.0.tgz'), '');
    assert.equal(
      findSingleFile(directory, '.tgz'),
      join(directory, 'zterm-cli-0.1.0.tgz'),
    );
    writeFileSync(join(directory, 'zterm-cli-0.2.0.tgz'), '');
    assert.throws(
      () => findSingleFile(directory, '.tgz'),
      /found 2/u,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('accepts object and serialized DAGpipe compile results', () => {
  assert.deepEqual(
    parseDaemonCompileResult('{"ok":true,"graphs":["a"]}'),
    { ok: true, graphs: ['a'] },
  );
  assert.deepEqual(
    parseDaemonCompileResult({ ok: true, graphs: [] }),
    { ok: true, graphs: [] },
  );
  assert.throws(
    () => parseDaemonCompileResult('{"ok":false,"error":"graph failure"}'),
    /graph failure/u,
  );
});

test('redacts environment secrets from nested evidence', () => {
  const secret = 'token-value-that-must-not-leak';
  const normalized = sanitizeValue({
    error: `request failed with ${secret}`,
    nested: [`again ${secret}`],
  }, [secret]);
  assert.equal(redactText(`prefix ${secret} suffix`, [secret]), 'prefix [REDACTED] suffix');
  assert.doesNotMatch(JSON.stringify(normalized), new RegExp(secret, 'u'));
});

test('redacts text evidence files and leaves packaged binaries alone', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-smoke-redact-'));
  const secret = 'workflow-secret-value';
  try {
    writeFileSync(
      join(directory, 'summary.json'),
      JSON.stringify({ message: secret }),
    );
    writeFileSync(join(directory, 'archive.tgz'), secret);
    const summary = redactEvidenceDirectory(directory, [secret]);
    assert.equal(summary.filesScanned, 1);
    assert.equal(summary.filesRedacted, 1);
    assert.doesNotMatch(
      readFileSync(join(directory, 'summary.json'), 'utf8'),
      new RegExp(secret, 'u'),
    );
    assert.equal(readFileSync(join(directory, 'archive.tgz'), 'utf8'), secret);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('prefers node-pty Linux build output over prebuild directories', () => {
  const directory = mkdtempSync(join(tmpdir(), 'platform-smoke-pty-'));
  const packageRoot = join(directory, 'node_modules', 'node-pty');
  const resolutionBase = join(directory, 'package.json');
  try {
    mkdirSync(join(packageRoot, 'build', 'Release'), { recursive: true });
    mkdirSync(join(packageRoot, 'lib'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'node-pty', main: 'lib/index.js' }),
    );
    writeFileSync(join(packageRoot, 'lib', 'index.js'), 'module.exports = {};\n');
    writeFileSync(join(packageRoot, 'build', 'Release', 'pty.node'), '');
    writeFileSync(resolutionBase, '{}\n');
    const installation = resolveNodePtyInstallation(
      resolutionBase,
      'linux',
      'x64',
    );
    assert.equal(
      installation.ptyNativeRelativePath,
      join('build', 'Release', 'pty.node'),
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('current host exposes the real wrtc native module', () => {
  const installation = resolveWrtcInstallation(
    join(packageDir, 'package.json'),
  );
  assert.match(installation.nativePath, /wrtc\.node$/u);
});

test('current host exposes node-pty and ConPTY native modules', () => {
  const installation = resolveNodePtyInstallation(
    join(repoRoot, 'android', 'package.json'),
  );
  assert.match(installation.ptyNativePath, /pty\.node$/u);
  assert.match(
    installation.ptyNativeRelativePath,
    /(?:build[\\/](?:Release|Debug)|prebuilds)[\\/].*pty\.node$/u,
  );
  if (process.platform === 'win32') {
    assert.match(installation.conPtyNativePath || '', /conpty\.node$/u);
  }
});
