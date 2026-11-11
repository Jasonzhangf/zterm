import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { linuxRunner } from './prepare-daemon-platform-release.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const generatorPath = join(scriptDir, 'prepare-global-daemon-release.sh');
const fixtures = [];

after(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createSupportFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'zterm-daemon-support-'));
  fixtures.push(fixture);
  const supportDir = join(fixture, 'support');
  const homeDir = join(fixture, 'home');
  mkdirSync(supportDir, { recursive: true });
  mkdirSync(join(homeDir, 'Library', 'LaunchAgents'), { recursive: true });

  const generator = readFileSync(generatorPath, 'utf8');
  const startMarker = 'cat > "${SUPPORT_DIR}/zterm-daemon.sh" <<\'EOF\'';
  const markerStart = generator.indexOf(startMarker);
  assert.notEqual(markerStart, -1, 'support script heredoc marker is missing');
  const scriptStart = generator.indexOf('\n', markerStart) + 1;
  const scriptEnd = generator.indexOf('\nEOF\n', scriptStart);
  assert.notEqual(scriptEnd, -1, 'support script heredoc terminator is missing');

  const supportScript = join(supportDir, 'zterm-daemon.sh');
  writeFileSync(supportScript, `${generator.slice(scriptStart, scriptEnd)}\n`, {
    mode: 0o755,
  });
  writeFileSync(
    join(supportDir, 'terminal-config-command.cjs'),
    'console.log("HOST=127.0.0.1");\n',
  );

  return { fixture, homeDir, supportScript };
}

function createLinuxSupportFixture() {
  const fixture = mkdtempSync(join(tmpdir(), 'zterm-linux-daemon-support-'));
  fixtures.push(fixture);
  const supportDir = join(fixture, 'support');
  const runtimeDir = join(fixture, 'runtime');
  const homeDir = join(fixture, 'home');
  mkdirSync(supportDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const supportScript = join(supportDir, 'zterm-daemon.sh');
  writeFileSync(supportScript, linuxRunner(), { mode: 0o755 });
  writeFileSync(
    join(supportDir, 'terminal-config-command.cjs'),
    'console.log("HOST=127.0.0.1");\n',
  );
  writeFileSync(join(runtimeDir, 'server.cjs'), 'process.exit(0);\n');
  writeFileSync(join(runtimeDir, 'dagpipe.node'), 'fixture\n');
  return { fixture, homeDir, supportScript };
}

function runSupportScript(fixture, args) {
  return spawnSync('bash', [fixture.supportScript, ...args], {
    cwd: fixture.fixture,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.homeDir,
    },
  });
}

test('restart help flags print usage without entering restart_service', () => {
  const fixture = createSupportFixture();
  for (const flag of ['--help', '-h']) {
    const result = runSupportScript(fixture, ['restart', flag]);
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /zterm-daemon restart/);
    assert.doesNotMatch(result.stderr, /not installed/);
  }
});

test('restart rejects unknown trailing arguments without entering restart_service', () => {
  const fixture = createSupportFixture();
  const result = runSupportScript(fixture, ['restart', '--force']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown restart option: --force/);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /not installed/);
});

test('restart without trailing arguments still enters restart_service', () => {
  const fixture = createSupportFixture();
  const result = runSupportScript(fixture, ['restart']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /zterm autostart service not installed/);
});

test('linux restart help flags and unknown arguments do not enter lifecycle', () => {
  const fixture = createLinuxSupportFixture();
  for (const flag of ['--help', '-h']) {
    const result = runSupportScript(fixture, ['restart', flag]);
    assert.equal(result.status, 0, `${flag}: ${result.stderr}`);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /zterm-daemon restart/);
    assert.doesNotMatch(result.stdout, /daemon stopped|daemon started/);
  }

  const unknown = runSupportScript(fixture, ['restart', '--force']);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown restart option: --force/);
  assert.doesNotMatch(unknown.stdout, /daemon stopped|daemon started/);
});
