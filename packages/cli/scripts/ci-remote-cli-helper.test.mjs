import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  collectTimingEvidence,
  compactTimingEvidenceLine,
  externalRtcConsumerPassed,
  projectTimingEvidence,
  rtcConsumerLog,
  summarizeVitestReport,
} from './ci-remote-cli-helper.mjs';

const ROUTE_EVIDENCE =
  'rtc-route-evidence: {"stage":"open","path":"rtc-relay","relayTransport":"turn","localCandidateType":"relay","remoteCandidateType":"relay"}';

const SAFE_TIMING_LINES = [
  'rtc-timing-evidence: {"event":"ws.construct","ms":3,"ws":1}',
  'rtc-timing-evidence: {"event":"network.secureConnect","ms":2102,"ws":1}',
  'rtc-timing-evidence: {"event":"ws.receive","ms":2400,"ws":1,"type":"rtc-answer"}',
];

const UNSAFE_TIMING_LINES = [
  'rtc-timing-evidence: {"event":"ws.open","ms":5,"token":"super-secret-token"}',
  'rtc-timing-evidence: {"event":"ws.open","ms":5,"url":"wss://relay.example.test/?token=secret-url"}',
  'rtc-timing-evidence: {"event":"ws.open","type":"wss://relay.example.test/secret"}',
  'rtc-timing-evidence: {"event":"ws.open","ms":-1}',
  'rtc-timing-evidence: {"event":"invented.event","ms":5}',
  'rtc-timing-evidence: not-json',
];

function vitestReport(stdout, {
  success = true,
  numFailedTests = 0,
  assertionStatus = 'passed',
} = {}) {
  return {
    success,
    numTotalTests: 1,
    numPassedTests: assertionStatus === 'passed' ? 1 : 0,
    numFailedTests,
    numPendingTests: 0,
    testResults: [
      {
        name: 'src/application-liveconsumer.test.ts',
        status: assertionStatus,
        assertionResults: [
          {
            title: 'live consumer',
            status: assertionStatus,
            ...(assertionStatus === 'failed'
              ? { failureMessages: ['route assertion failed'] }
              : {}),
          },
        ],
        console: { stdout },
      },
    ],
  };
}

test('preserves only safe native timing from consumer stdout', () => {
  const summary = summarizeVitestReport(
    vitestReport(
      [...SAFE_TIMING_LINES, ...UNSAFE_TIMING_LINES].join('\n'),
    ),
  );
  assert.deepEqual(summary.timingEvidence, SAFE_TIMING_LINES);
  assert.doesNotMatch(
    JSON.stringify(summary.timingEvidence),
    /super-secret-token|relay\.example\.test|secret-url/u,
  );
  assert.deepEqual(summary.routeEvidence, []);
});

test('rejects malformed and injected timing payloads at the log boundary', () => {
  for (const line of UNSAFE_TIMING_LINES) {
    assert.equal(compactTimingEvidenceLine(line), '');
  }
  assert.equal(
    compactTimingEvidenceLine(
      'rtc-timing-evidence: {"event":"ws.open","ms":4,"ws":1}',
    ),
    'rtc-timing-evidence: {"event":"ws.open","ms":4,"ws":1}',
  );
});

test('projects native timing without carrying arbitrary observer metadata', () => {
  assert.equal(
    projectTimingEvidence({
      acceptance: false,
      call: 1,
      event: 'createOffer.begin',
      ms: 12.5,
      pc: 1,
    }),
    null,
  );
  assert.equal(
    projectTimingEvidence({
      event: 'ws.send',
      ws: 2,
      token: 'must-not-escape',
    }),
    null,
  );
  assert.equal(
    projectTimingEvidence({ event: 'ws.send', ms: 'slow' }),
    null,
  );
});

test('timing evidence cannot satisfy route acceptance or rescue failures', () => {
  const timingOnly = summarizeVitestReport(
    vitestReport(SAFE_TIMING_LINES.join('\n')),
  );
  assert.equal(externalRtcConsumerPassed(timingOnly), false);

  const routeAndTiming = summarizeVitestReport(
    vitestReport([ROUTE_EVIDENCE, ...SAFE_TIMING_LINES].join('\n')),
  );
  assert.equal(externalRtcConsumerPassed(routeAndTiming), true);

  const failed = summarizeVitestReport(
    vitestReport([ROUTE_EVIDENCE, ...SAFE_TIMING_LINES].join('\n'), {
      success: false,
      numFailedTests: 1,
      assertionStatus: 'failed',
    }),
  );
  assert.equal(externalRtcConsumerPassed(failed), false);
});

test('sanitized command log keeps safe timing and omits raw secrets', () => {
  const log = rtcConsumerLog({
    command: 'node',
    args: ['vitest', 'run', 'src/application-liveconsumer.test.ts'],
    exitCode: 1,
    signal: null,
    timedOut: false,
    durationMs: 42,
    stdout: [...SAFE_TIMING_LINES, ...UNSAFE_TIMING_LINES].join('\n'),
    stderr: 'stderr token=super-secret-token',
  }, [], []);
  assert.match(log, /\[safe-timing-output\]/u);
  for (const line of SAFE_TIMING_LINES) {
    assert.equal(log.includes(line), true);
  }
  assert.doesNotMatch(
    log,
    /super-secret-token|relay\.example\.test|secret-url/u,
  );
  assert.match(log, /\[other-output-omitted\]/u);
});

test('bounds timing evidence for a single API diagnostic', () => {
  const lines = Array.from({ length: 600 }, (_, index) =>
    `rtc-timing-evidence: ${JSON.stringify({
      event: 'ws.send',
      ms: index,
      ws: 1,
    })}`);
  assert.equal(collectTimingEvidence(lines.join('\n')).length, 512);
});
