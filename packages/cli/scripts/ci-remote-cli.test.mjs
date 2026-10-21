import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_REMOTE_RECEIPT_ENV,
  CI_REMOTE_REQUIRED_ENV,
  CI_REMOTE_RESULT_FILE,
  compactRouteEvidenceLine,
  createChildEnvironment,
  createRemoteUserPathArgs,
  createRtcConsumerEnvironment,
  deriveCiRemoteOutcome,
  externalRtcConsumerPassed,
  normalizeReceiptText,
  parseCiRemoteArgs,
  parseRequiredFlag,
  receiptSecrets,
  resolveInstalledJsBin,
  runCiRemoteCli,
  summarizeVitestReport,
  writePrivateReceipt,
} from './ci-remote-cli-helper.mjs';
import { installedCliPackageRoot } from './platform-smoke-helper.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..', '..');

function withTempDirectory(action) {
  const root = mkdtempSync(join(tmpdir(), 'ci-remote-cli-test-'));
  try {
    return action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function withTempDirectoryAsync(action) {
  const root = mkdtempSync(join(tmpdir(), 'ci-remote-cli-test-'));
  try {
    return await action(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function receipt() {
  return {
    schemaVersion: 1,
    managedTest: true,
    runId: 'managed-run',
    relayBaseUrl: 'https://relay.example.test/',
    publicRelayBaseUrl: 'https://relay.example.test/',
    username: 'managed-user',
    password: 'managed-password-value',
    deviceId: 'managed-device',
    daemonHostId: 'managed-daemon',
    sessionName: 'rtc-fixture-managed-run',
    backend: 'tmux',
    stableId: 'tmux:$1:managed-stable',
  };
}

test('requires exactly the four CI helper arguments', () => {
  const full = [
    '--cli-tarball',
    './zterm-cli.tgz',
    '--daemon-payload-root',
    './payload',
    '--evidence-dir',
    './evidence',
    '--private-receipt-dir',
    './private',
  ];
  const parsed = parseCiRemoteArgs(full);
  assert.equal(parsed.cliTarball, resolve('./zterm-cli.tgz'));
  assert.equal(parsed.daemonPayloadRoot, resolve('./payload'));
  assert.equal(parsed.evidenceDir, resolve('./evidence'));
  assert.equal(parsed.privateReceiptDir, resolve('./private'));
  assert.throws(
    () => parseCiRemoteArgs(full.slice(0, -2)),
    /missing required arguments: --private-receipt-dir/u,
  );
  assert.throws(
    () => parseCiRemoteArgs([...full, '--other', 'value']),
    /unknown argument/u,
  );
});

test('requires and records the managed receipt without treating its absence as pass', () => {
  assert.equal(parseRequiredFlag(undefined), false);
  assert.equal(parseRequiredFlag('false'), false);
  assert.equal(parseRequiredFlag('true'), true);
  assert.throws(() => parseRequiredFlag('sometimes'), /must be a boolean/u);

  const optionalGap = deriveCiRemoteOutcome({
    receiptPresent: false,
    required: false,
    setupPassed: false,
    stages: [],
    cleanupPassed: true,
  });
  assert.equal(optionalGap.state, 'UNVERIFIED');
  assert.equal(optionalGap.ok, true);

  const requiredGap = deriveCiRemoteOutcome({
    receiptPresent: false,
    required: true,
    setupPassed: false,
    stages: [],
    cleanupPassed: true,
  });
  assert.equal(requiredGap.state, 'FAILED');
  assert.equal(requiredGap.ok, false);

  const complete = deriveCiRemoteOutcome({
    receiptPresent: true,
    required: true,
    setupPassed: true,
    stages: [
      { name: 'remote-cli-user-path', status: 'passed' },
      { name: 'rtc-consumer', status: 'passed' },
    ],
    cleanupPassed: true,
  });
  assert.equal(complete.state, 'PASSED');
  assert.equal(complete.ok, true);

  const partial = deriveCiRemoteOutcome({
    receiptPresent: true,
    required: false,
    setupPassed: true,
    stages: [
      { name: 'remote-cli-user-path', status: 'passed' },
      { name: 'rtc-consumer', status: 'failed' },
    ],
    cleanupPassed: true,
  });
  assert.equal(partial.state, 'FAILED');
  assert.equal(partial.ok, false);
});

test('installs through an isolated child environment without inherited secrets', () => {
  withTempDirectory((root) => {
    const env = createChildEnvironment(
      root,
      join(root, 'prefix'),
      {
        PATH: '/test/bin',
        HOME: '/real/home',
        [CI_REMOTE_RECEIPT_ENV]: '{"password":"secret"}',
        GITHUB_TOKEN: 'github-secret',
      },
    );
    assert.equal(env.HOME, join(root, 'home'));
    assert.equal(env.USERPROFILE, join(root, 'home'));
    assert.equal(env.npm_config_prefix, join(root, 'prefix'));
    assert.equal(env[CI_REMOTE_RECEIPT_ENV], undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.PATH, '/test/bin');
  });
});

test('writes a private UTF-8 receipt without BOM and removes secrets from logs', () => {
  withTempDirectory((root) => {
    const value = receipt();
    const text = `\uFEFF${JSON.stringify(value)}`;
    const result = writePrivateReceipt({
      secret: text,
      privateReceiptDir: join(root, 'private'),
      platform: process.platform,
      env: process.env,
    });
    const bytes = readFileSync(result.receiptPath);
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(bytes.toString('utf8'), JSON.stringify(value));
    if (process.platform !== 'win32') {
      assert.equal(statSync(result.receiptPath).mode & 0o777, 0o600);
    }
    assert.equal(
      receiptSecrets(text, {}).includes('managed-password-value'),
      true,
    );
    assert.equal(
      normalizeReceiptText(`\uFEFF${JSON.stringify(value)}`)
        .startsWith('\uFEFF'),
      false,
    );
    assert.throws(
      () => normalizeReceiptText('   '),
      /is empty/u,
    );
  });
});

test('resolves only the JavaScript bin.zterm from an installed package', () => {
  withTempDirectory((root) => {
    const packageRoot = installedCliPackageRoot(root);
    mkdirSync(join(packageRoot, 'bin'), { recursive: true });
    writeFileSync(
      join(packageRoot, 'package.json'),
      JSON.stringify({
        name: '@jsonstudio/zterm-cli',
        version: '1.2.3',
        bin: { zterm: './bin/zterm.mjs' },
      }),
    );
    writeFileSync(
      join(packageRoot, 'bin', 'zterm.mjs'),
      '#!/usr/bin/env node\n',
      { mode: 0o755 },
    );
    chmodSync(join(packageRoot, 'bin', 'zterm.mjs'), 0o755);
    const resolved = resolveInstalledJsBin(root);
    assert.equal(
      resolved.cliBin,
      realpathSync(join(packageRoot, 'bin', 'zterm.mjs')),
    );
    assert.equal(resolved.name, '@jsonstudio/zterm-cli');
  });
});

test('CI test is restricted to the external consumer file and native Windows', () => {
  const helper = readFileSync(
    join(repoRoot, 'packages', 'cli', 'scripts', 'ci-remote-cli-helper.mjs'),
    'utf8',
  );
  assert.match(helper, /src\/application-liveconsumer\.test\.ts/u);
  assert.doesNotMatch(helper, /docker|wsl(?:\.exe)?/iu);
  assert.match(helper, /windows_runner_required/u);
  assert.match(helper, /passedAssertions >= 1/u);
  assert.match(helper, /ZTERM_RTC_FIXTURE_RECEIPT/u);
  assert.match(helper, /ZTERM_RTC_FIXTURE_EVIDENCE_DIR/u);
  assert.equal(
    [
      '--receipt-file',
      '--cli-bin',
      '--pty-package-root',
      '--evidence-dir',
    ].every((argument) => helper.includes(argument)),
    true,
  );
  assert.equal(CI_REMOTE_REQUIRED_ENV, 'ZTERM_REQUIRE_REMOTE_CLI');
});

test('keeps the fixed runner arguments and external RTC environment separate', () => {
  const args = createRemoteUserPathArgs({
    privateReceiptPath: '/runner/private/receipt.json',
    cliBin: '/runner/cli/bin/zterm.mjs',
    ptyPackageRoot: '/runner/payload/runtime/node_modules',
    evidenceDir: '/runner/evidence/remote-user-path',
  });
  assert.deepEqual(args, [
    '--receipt-file',
    '/runner/private/receipt.json',
    '--cli-bin',
    '/runner/cli/bin/zterm.mjs',
    '--pty-package-root',
    '/runner/payload/runtime/node_modules',
    '--evidence-dir',
    '/runner/evidence/remote-user-path',
  ]);
  const env = createRtcConsumerEnvironment({
    baseEnv: { PATH: '/test/bin' },
    privateReceiptPath: '/runner/private/receipt.json',
    evidenceDir: '/runner/evidence/rtc-consumer',
  });
  assert.deepEqual(env, {
    PATH: '/test/bin',
    ZTERM_RTC_FIXTURE_RECEIPT: '/runner/private/receipt.json',
    ZTERM_RTC_FIXTURE_EVIDENCE_DIR: '/runner/evidence/rtc-consumer',
  });
});

for (const bridgeMode of ['plain', 'bridge', 'bridge-close-failure']) {
test(`actual CI orchestration owns receipt and sidecar lifecycle: ${bridgeMode}`, async () => {
  await withTempDirectoryAsync(async (root) => {
    const evidenceDir = join(root, 'evidence');
    const privateReceiptDir = join(root, 'private');
    const cliTarball = join(root, 'zterm-cli.tgz');
    const daemonPayloadRoot = join(root, 'payload');
    mkdirSync(daemonPayloadRoot, { recursive: true });
    writeFileSync(cliTarball, 'managed CLI fixture\n');

    let materializedReceiptPath = '';
    let userPathReceipt = '';
    let rtcReceipt = '';
    let rtcEvidenceDir = '';
    const lifecycle = [];
    const inputReceipt = receipt();
    if (bridgeMode !== 'plain') inputReceipt.fixtureTransport = {
      kind: 'turn-tcp-over-authenticated-wss', bridgeUrl: 'wss://fixture.example.test/fixture/turn',
      token: 'private-sidecar-token', listeningPort: 49153,
    };

    const resultFor = (command, args) => ({
      command,
      args,
      exitCode: 0,
      signal: null,
      timedOut: false,
      error: null,
      stdout: '',
      stderr: '',
      durationMs: 1,
    });

    const previousExitCode = process.exitCode;
    const exitCode = await runCiRemoteCli({
      argv: [
        '--cli-tarball',
        cliTarball,
        '--daemon-payload-root',
        daemonPayloadRoot,
        '--evidence-dir',
        evidenceDir,
        '--private-receipt-dir',
        privateReceiptDir,
      ],
      env: {
        PATH: process.env.PATH,
        [CI_REMOTE_RECEIPT_ENV]: JSON.stringify(inputReceipt),
      },
      platform: 'win32',
      arch: 'x64',
      nodeVersion: 'v22.0.0',
      bridgeSpawner: ({ controlPath, logPath }) => {
        lifecycle.push('spawn');
        const control = JSON.parse(readFileSync(controlPath, 'utf8'));
        assert.equal(control.options.listenPort, 49153);
        assert.equal(control.options.listenHost, '127.0.0.1');
        assert.equal(control.options.token, 'private-sidecar-token');
        assert(!logPath.startsWith(evidenceDir));
        return { pid: 123, ready: Promise.resolve(),
          assertHealthy: async () => lifecycle.push('healthy'),
          close: async () => {
            assert(existsSync(controlPath), 'control must remain until bridge closes');
            assert(existsSync(materializedReceiptPath));
            lifecycle.push('close');
            return { closed: bridgeMode !== 'bridge-close-failure', errors: [] };
          },
        };
      },
      receiptWriter: ({ secret, privateReceiptDir: parentDir }) => {
        const runDir = join(parentDir, 'receipt-test');
        mkdirSync(runDir, { recursive: true, mode: 0o700 });
        const receiptPath = join(runDir, 'managed-receipt.json');
        writeFileSync(receiptPath, secret, { mode: 0o600 });
        materializedReceiptPath = receiptPath;
        return { receiptPath, runDir };
      },
      commandRunner: (command, args, options) => {
        if (args.includes('install') && args.includes('--prefix')) {
          const packageRoot = installedCliPackageRoot(options.env.npm_config_prefix);
          mkdirSync(join(packageRoot, 'bin'), { recursive: true });
          writeFileSync(
            join(packageRoot, 'package.json'),
            JSON.stringify({
              name: '@jsonstudio/zterm-cli',
              version: '0.1.0',
              bin: { zterm: './bin/zterm.mjs' },
            }),
          );
          writeFileSync(
            join(packageRoot, 'bin', 'zterm.mjs'),
            '#!/usr/bin/env node\n',
            { mode: 0o755 },
          );
          return resultFor(command, args);
        }
        if (args.some((arg) => arg.endsWith('remote-cli-blackbox.mjs'))) {
          if (bridgeMode !== 'plain') assert.equal(lifecycle.at(-1), 'healthy');
          lifecycle.push('user');
          userPathReceipt = args[args.indexOf('--receipt-file') + 1];
          assert.equal(options.env[CI_REMOTE_RECEIPT_ENV], undefined);
          assert.equal(options.env.ZTERM_RTC_FIXTURE_RECEIPT, undefined);
          const stageDir = args[args.indexOf('--evidence-dir') + 1];
          writeFileSync(
            join(stageDir, 'remote-cli-result.json'),
            JSON.stringify({
              coverage: 'remote-cli-user-path',
              outcome: { state: 'PASSED' },
              client: { os: 'win32' },
            }),
          );
          return resultFor(command, args);
        }
        if (args.some((arg) => arg.endsWith('application-liveconsumer.test.ts'))) {
          if (bridgeMode !== 'plain') assert.equal(lifecycle.at(-1), 'healthy');
          lifecycle.push('rtc');
          rtcReceipt = options.env.ZTERM_RTC_FIXTURE_RECEIPT;
          rtcEvidenceDir = options.env.ZTERM_RTC_FIXTURE_EVIDENCE_DIR;
          const reportPath = args[args.indexOf('--outputFile') + 1];
          writeFileSync(
            reportPath,
            JSON.stringify({
              success: true,
              numTotalTests: 1,
              numPassedTests: 1,
              numFailedTests: 0,
              numPendingTests: 0,
              testResults: [{
                name: '/repo/packages/cli/src/application-liveconsumer.test.ts',
                status: 'passed',
                assertionResults: [{
                  title: 'RTC consumer',
                  status: 'passed',
                }],
              }],
            }),
          );
          return {
            ...resultFor(command, args),
            stdout: 'rtc-route-evidence: {"stage":"open","path":"rtc-relay","relayTransport":"turn","localCandidateType":"relay","remoteCandidateType":"relay"}\n',
          };
        }
        assert.fail(`unexpected orchestration command: ${command}`);
      },
    });

    process.exitCode = previousExitCode;
    assert.equal(exitCode, bridgeMode === 'bridge-close-failure' ? 1 : 0);
    assert.equal(userPathReceipt, materializedReceiptPath);
    assert.equal(rtcReceipt, materializedReceiptPath);
    assert.equal(
      rtcEvidenceDir,
      join(evidenceDir, 'rtc-consumer'),
    );
    const result = JSON.parse(
      readFileSync(join(evidenceDir, CI_REMOTE_RESULT_FILE), 'utf8'),
    );
    assert.equal(result.outcome.state, bridgeMode === 'bridge-close-failure' ? 'FAILED' : 'PASSED');
    assert.doesNotMatch(JSON.stringify(result), /private-sidecar-token/);
    if (bridgeMode !== 'plain') assert.deepEqual(lifecycle, ['spawn', 'healthy', 'user', 'healthy', 'rtc', 'healthy', 'close']);
    assert.equal(existsSync(materializedReceiptPath), bridgeMode === 'bridge-close-failure');
    assert.equal(result.stages[0].status, 'passed');
    assert.equal(result.stages[1].status, 'passed');
  });
});
}

test('a skipped Vitest assertion cannot become a remote consumer pass', () => {
  const base = {
    success: true,
    numTotalTests: 1,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 0,
    testResults: [{
      name: '/repo/packages/cli/src/application-liveconsumer.test.ts',
      status: 'passed',
      assertionResults: [{
        title: 'RTC consumer',
        status: 'skipped',
      }],
      console: {
        stdout: 'rtc-route-evidence: {"stage":"open","path":"rtc-relay","relayTransport":"turn","localCandidateType":"relay","remoteCandidateType":"host","token":"must-not-upload"}\n',
      },
    }],
  };
  const skipped = summarizeVitestReport(base);
  assert.equal(externalRtcConsumerPassed(skipped), false);
  assert.deepEqual(skipped.routeEvidence, [
    'rtc-route-evidence: {"stage":"open","path":"rtc-relay","relayTransport":"turn","localCandidateType":"relay","remoteCandidateType":"host"}',
  ]);
  assert.doesNotMatch(JSON.stringify(skipped.routeEvidence), /must-not-upload/u);
  assert.equal(
    compactRouteEvidenceLine('rtc-route-evidence: {"token":"x"}'),
    '',
  );
  base.testResults[0].assertionResults[0].status = 'passed';
  assert.equal(externalRtcConsumerPassed(summarizeVitestReport(base)), false);
  base.testResults[0].console.stdout = 'rtc-route-evidence: {"stage":"open","path":"rtc-relay","relayTransport":"turn","localCandidateType":"relay","remoteCandidateType":"relay"}\n';
  assert.equal(externalRtcConsumerPassed(summarizeVitestReport(base)), true);
});
