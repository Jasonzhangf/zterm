import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

interface CaseSummary {
  caseName: string;
  ok: boolean;
}

interface CompareResult {
  ok: boolean;
}

interface StepResult {
  label: string;
  ok: boolean;
}

interface ProbeEventEntry {
  at: string;
  direction: 'sent' | 'recv';
  type: string;
  payload?: unknown;
}

interface AuditCaseResult {
  caseName: string;
  ok: boolean;
  checks: Record<string, boolean>;
  eventCount: number;
  firstEvents: string[];
  lastEvents: string[];
}

function currentDateFolder() {
  return new Date().toISOString().slice(0, 10);
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function eventToken(entry: ProbeEventEntry) {
  return `${entry.direction}:${entry.type}`;
}

function findOrderedSequence(events: ProbeEventEntry[], requiredTokens: string[]) {
  let cursor = 0;
  for (const token of requiredTokens) {
    let matched = false;
    while (cursor < events.length) {
      if (eventToken(events[cursor]!) === token) {
        matched = true;
        cursor += 1;
        break;
      }
      cursor += 1;
    }
    if (!matched) {
      return false;
    }
  }
  return true;
}

function hasEventAfter(events: ProbeEventEntry[], startIndex: number, token: string) {
  for (let index = Math.max(0, startIndex); index < events.length; index += 1) {
    if (eventToken(events[index]!) === token) {
      return true;
    }
  }
  return false;
}

function loadOptionalStepResults(caseDir: string) {
  const path = join(caseDir, 'step-results.json');
  if (!existsSync(path)) {
    return [] as StepResult[];
  }
  return readJson<StepResult[]>(path);
}

function auditCase(rootDir: string, summary: CaseSummary): AuditCaseResult {
  const caseDir = join(rootDir, summary.caseName);
  const events = readJson<ProbeEventEntry[]>(join(caseDir, 'probe-events.json'));
  const compare = readJson<CompareResult>(join(caseDir, 'comparison.json'));
  const clientCompare = readJson<CompareResult>(join(caseDir, 'client-mirror-comparison.json'));
  const steps = loadOptionalStepResults(caseDir);

  const checks: Record<string, boolean> = {
    daemonCompare: compare.ok,
    clientCompare: clientCompare.ok,
    stepsOk: steps.every((step) => step.ok),
  };

  if (summary.caseName === 'initial-sync') {
    checks.startupSequence = findOrderedSequence(events, [
      'sent:connect',
      'recv:connected',
      'sent:buffer-head-request',
      'recv:buffer-head',
      'sent:buffer-sync-request',
      'recv:buffer-sync',
    ]);
  }

  if (summary.caseName === 'local-input-echo') {
    const lastInputIndex = events.map(eventToken).lastIndexOf('sent:input');
    checks.inputSent = lastInputIndex >= 0;
    checks.inputHeadRefresh = lastInputIndex >= 0 && hasEventAfter(events, lastInputIndex + 1, 'recv:buffer-head');
    checks.inputBufferRefresh = lastInputIndex >= 0 && hasEventAfter(events, lastInputIndex + 1, 'recv:buffer-sync');
  }

  if (summary.caseName === 'external-input-echo') {
    const firstSyncIndex = events.findIndex((entry) => eventToken(entry) === 'recv:buffer-sync');
    checks.externalHeadRefresh = firstSyncIndex >= 0 && hasEventAfter(events, firstSyncIndex + 1, 'recv:buffer-head');
    checks.externalBufferRefresh = firstSyncIndex >= 0 && hasEventAfter(events, firstSyncIndex + 1, 'recv:buffer-sync');
  }

  if (summary.caseName === 'daemon-restart-recover') {
    const connectSentCount = events.filter((entry) => eventToken(entry) === 'sent:connect').length;
    const connectedCount = events.filter((entry) => eventToken(entry) === 'recv:connected').length;
    const secondConnectIndex = events.findIndex((entry, index) => (
      index > 0 && eventToken(entry) === 'sent:connect'
    ));
    checks.reconnectTwice = connectSentCount >= 2 && connectedCount >= 2;
    checks.reconnectHeadRefresh = secondConnectIndex >= 0 && hasEventAfter(events, secondConnectIndex + 1, 'recv:buffer-head');
    checks.reconnectBufferRefresh = secondConnectIndex >= 0 && hasEventAfter(events, secondConnectIndex + 1, 'recv:buffer-sync');
  }

  if (summary.caseName === 'codex-live' || summary.caseName === 'top-live' || summary.caseName === 'vim-live') {
    checks.bufferSyncReceived = events.some((entry) => eventToken(entry) === 'recv:buffer-sync');
    checks.headReceived = events.some((entry) => eventToken(entry) === 'recv:buffer-head');
  }

  const ok = Object.values(checks).every(Boolean);
  return {
    caseName: summary.caseName,
    ok,
    checks,
    eventCount: events.length,
    firstEvents: events.slice(0, 8).map(eventToken),
    lastEvents: events.slice(-8).map(eventToken),
  };
}

function main() {
  const requestedDir = process.argv[2]
    ? resolve(process.cwd(), process.argv[2])
    : resolve(process.cwd(), 'evidence', 'daemon-mirror', currentDateFolder());
  const summaryPath = join(requestedDir, 'summary.json');
  if (!existsSync(summaryPath)) {
    throw new Error(`summary.json not found: ${summaryPath}`);
  }

  const summary = readJson<CaseSummary[]>(summaryPath);
  const caseResults = summary.map((item) => auditCase(requestedDir, item));
  const payload = {
    ok: caseResults.every((item) => item.ok),
    generatedAt: new Date().toISOString(),
    rootDir: requestedDir,
    cases: caseResults,
  };
  writeFileSync(join(requestedDir, 'strict-audit.json'), `${JSON.stringify(payload, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.ok) {
    process.exitCode = 1;
  }
}

main();
